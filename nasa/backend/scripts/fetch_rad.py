"""Télécharge des mesures de dose réelles du détecteur RAD de Curiosity (PDS PPI)
et en tire le débit de dose utilisé pour estimer la dose d'une sortie EVA.

ATTENTION : RAD est sur Curiosity, dans le cratère Gale (~3 700 km de Jezero).
Le débit de dose de surface dépend surtout de l'épaisseur d'atmosphère et du cycle
solaire, pas du lieu exact : on l'utilise comme ORDRE DE GRANDEUR pour Jezero,
et l'interface doit le dire.

Données : MSL-M-RAD-3-RDR-V1.0, un fichier ASCII par sol (~12 Mo), une observation
toutes les ~16 min avec deux débits de dose :
    DOSIMETRY_TOTAL_DOSE_B  détecteur silicium B         (µGy/h)
    DOSIMETRY_TOTAL_DOSE_E  scintillateur plastique E    (µGy/h, proche du tissu humain)

Usage (depuis backend/) :
    python scripts/fetch_rad.py                  # sols 361-365 (août 2013)
    python scripts/fetch_rad.py --sols 1000-1004

Sorties :
    data/radiation/rad_dose_sols_<a>_<b>.csv     une ligne par observation
    data/radiation/rad_summary.json              débits moyens, servi par GET /radiation
Les fichiers bruts sont mis en cache dans data/rad_raw/ (non versionné).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA"
BACKEND_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = BACKEND_DIR / "data" / "rad_raw"
OUT_DIR = BACKEND_DIR / "data" / "radiation"
UA = {"User-Agent": "eva-planner-hackathon/0.1"}

# Facteur de qualité moyen mesuré par RAD à la surface (Hassler et al., Science 2014) :
# dose équivalente ≈ 3,05 × dose absorbée dans le tissu.
QUALITY_FACTOR = 3.05


def http_get(url: str, timeout: int = 300) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def list_links(url: str) -> list[str]:
    html = http_get(url, 60).decode("utf-8", "replace")
    return re.findall(r'href="([^"?/][^"]*)"', html)


def sol_folder(sol: int) -> str:
    for name in list_links(BASE + "/"):
        m = re.match(r"SOL_(\d+)_(\d+)/", name)
        if m and int(m.group(1)) <= sol <= int(m.group(2)):
            return name.rstrip("/")
    raise SystemExit(f"Sol {sol} introuvable dans l'archive RAD")


def fetch_sol_file(sol: int) -> Path:
    cached = sorted(RAW_DIR.glob(f"RAD_RDR_*_{sol:04d}_V*.TXT"))
    if cached:
        return cached[-1]
    folder = sol_folder(sol)
    names = [n for n in list_links(f"{BASE}/{folder}/") if re.match(rf"RAD_RDR_.*_{sol:04d}_V\d+\.TXT$", n)]
    if not names:
        raise SystemExit(f"Aucun fichier RAD pour le sol {sol}")
    name = sorted(names)[-1]
    print(f"  téléchargement {name} ...", flush=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / name
    path.write_bytes(http_get(f"{BASE}/{folder}/{name}"))
    return path


def parse_rad(path: Path) -> list[dict]:
    """Extrait (heure UTC, heure Mars, dose B, dose E) de chaque observation."""
    obs: dict[str, dict] = {}
    section, idx = None, None
    expect_value = None
    with open(path, encoding="ascii", errors="replace") as f:
        for line in f:
            line = line.strip()
            m = re.match(r"^\[([A-Z0-9_]+): (\d+)\]$", line)
            if m:
                section, idx = m.group(1), m.group(2)
                expect_value = section if section.startswith("DOSIMETRY_TOTAL_DOSE_") else None
                obs.setdefault(idx, {})
                continue
            if section == "OBSERVATION" and "=" in line:
                k, v = line.split("=", 1)
                if k in ("START_OBS_UTC", "START_OBS_MARS"):
                    obs[idx][k] = v.strip('"')
            elif expect_value and line:
                try:
                    obs[idx][expect_value] = float(line)
                except ValueError:
                    pass
                expect_value = None
    rows = []
    for o in obs.values():
        b, e = o.get("DOSIMETRY_TOTAL_DOSE_B"), o.get("DOSIMETRY_TOTAL_DOSE_E")
        if "START_OBS_UTC" not in o or b is None or e is None or b <= 0 or e <= 0:
            continue  # valeurs manquantes (-1/-2) ou observation incomplète
        t = datetime.strptime(o["START_OBS_UTC"], "%Y-%j %H:%M:%S").replace(tzinfo=timezone.utc)
        rows.append({"utc": t.isoformat(), "mars_time": o.get("START_OBS_MARS", ""),
                     "dose_b_uGy_h": b, "dose_e_uGy_h": e})
    return sorted(rows, key=lambda r: r["utc"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sols", default="361-365", help="plage de sols Curiosity, ex. 361-365")
    args = ap.parse_args()
    a, b = map(int, args.sols.split("-"))

    rows = []
    for sol in range(a, b + 1):
        print(f"Sol {sol}")
        r = parse_rad(fetch_sol_file(sol))
        for x in r:
            x["sol"] = sol
        print(f"  {len(r)} observations valides")
        rows.extend(r)
    if not rows:
        raise SystemExit("Aucune mesure de dose exploitable")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / f"rad_dose_sols_{a}_{b}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["sol", "utc", "mars_time", "dose_b_uGy_h", "dose_e_uGy_h"])
        w.writeheader()
        w.writerows(rows)

    e = [r["dose_e_uGy_h"] for r in rows]
    bvals = [r["dose_b_uGy_h"] for r in rows]
    e_mean = statistics.fmean(e)
    summary = {
        "source": {
            "nom": "MSL Curiosity RAD, Reduced Data Records (PDS PPI)",
            "dataset": "MSL-M-RAD-3-RDR-V1.0",
            "url": BASE,
            "sols": [a, b],
            "periode_utc": [rows[0]["utc"], rows[-1]["utc"]],
            "recupere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "lieu_mesure": "Cratère Gale (Curiosity), pas Jezero",
        "avertissement": "Mesure réelle de Curiosity à Gale, utilisée comme ordre de grandeur pour Jezero. "
                         "Estimation pédagogique, pas une prévision opérationnelle de dose.",
        "observations": len(rows),
        "debit_dose_tissu_uGy_h": {"moyenne": round(e_mean, 3), "min": round(min(e), 3),
                                   "max": round(max(e), 3), "ecart_type": round(statistics.pstdev(e), 3)},
        "debit_dose_silicium_uGy_h": {"moyenne": round(statistics.fmean(bvals), 3)},
        "debit_dose_tissu_mGy_jour": round(e_mean * 24 / 1000, 4),
        "facteur_qualite": QUALITY_FACTOR,
        "facteur_qualite_source": "Hassler et al., Science 343 (2014), mesure RAD de surface",
        "debit_equivalent_uSv_h": round(e_mean * QUALITY_FACTOR, 3),
        "debit_equivalent_mSv_jour": round(e_mean * QUALITY_FACTOR * 24 / 1000, 4),
        "fichier_detail": csv_path.name,
    }
    (OUT_DIR / "rad_summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nDébit moyen (tissu) : {e_mean:.2f} µGy/h = {e_mean * 24 / 1000:.3f} mGy/jour "
          f"≈ {e_mean * QUALITY_FACTOR * 24 / 1000:.2f} mSv/jour")
    print(f"-> {csv_path.relative_to(BACKEND_DIR)} et data/radiation/rad_summary.json")


if __name__ == "__main__":
    main()
