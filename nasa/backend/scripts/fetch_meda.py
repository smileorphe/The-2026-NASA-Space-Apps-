"""Télécharge des mesures météo réelles de la station MEDA de Perseverance (dans Jezero)
et les résume pour le bandeau météo et le briefing GO / NO-GO.

Source : PDS Atmospheres Node (NMSU), archive PDS4 mars2020_meda.
Produits utilisés (un CSV par sol, mesures ~1 Hz) :
    CAL_ATS   température de l'air (5 capteurs ATS, K)            -> médiane des capteurs
    DER_PS    pression (Pa)
    DER_WS    vent horizontal (m/s) et direction (°)
    DER_TIRS  rayonnement infrarouge montant (W/m²)               -> température de brillance du sol
Valeur manquante dans l'archive : 999999999.

Usage (depuis backend/) :
    python scripts/fetch_meda.py                 # sols 300-302
    python scripts/fetch_meda.py --sols 1200-1202

Sorties :
    data/meteo/meda_sols_<a>_<b>.json   résumé par sol + profil horaire (heure solaire locale)
    data/meteo/meda_summary.json        dernier sol de la plage, servi par GET /weather
Les CSV bruts (~4 Mo chacun) sont mis en cache dans data/meda_raw/ (non versionné).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import statistics
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
BACKEND_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = BACKEND_DIR / "data" / "meda_raw"
OUT_DIR = BACKEND_DIR / "data" / "meteo"
UA = {"User-Agent": "eva-planner-hackathon/0.1"}
MISSING = 999999999.0
SIGMA = 5.670374419e-8                     # constante de Stefan-Boltzmann
# Sol 0 de Perseverance = 18 février 2021 ; 1 sol = 1,0274912517 jour terrestre.
SOL0_UTC = datetime(2021, 2, 18, tzinfo=timezone.utc)
SOL_DAYS = 1.0274912517

PRODUCTS = {
    # nom : (collection, code produit dans le nom de fichier)
    "ATS": ("data_calibrated_env", "CAL_ATS"),
    "PS": ("data_derived_env", "DER_PS"),
    "WS": ("data_derived_env", "DER_WS"),
    "TIRS": ("data_derived_env", "DER_TIRS"),
}
EVA_WINDOW_LTST = (7.0, 14.0)  # créneau type d'une sortie (heure solaire locale)


def http_get(url: str, timeout: int = 600) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def range_folder(sol: int, collection: str) -> str:
    import re
    html = http_get(f"{BASE}/{collection}/", 60).decode("utf-8", "replace")
    for a, b in re.findall(r'href="sol_(\d{4})_(\d{4})/"', html):
        if int(a) <= sol <= int(b):
            return f"sol_{a}_{b}"
    raise SystemExit(f"Sol {sol} absent de {collection}")


def fetch_csv(sol: int, product: str) -> Path:
    collection, code = PRODUCTS[product]
    cached = sorted(RAW_DIR.glob(f"WE__{sol:04d}*{code}_*.CSV"))
    if cached:
        return cached[-1]
    import re
    folder = f"{BASE}/{collection}/{range_folder(sol, collection)}/sol_{sol:04d}/"
    html = http_get(folder, 60).decode("utf-8", "replace")
    names = sorted(set(re.findall(rf'href="(WE__{sol:04d}_+{code}_+P\d+\.CSV)"', html)))
    if not names:
        raise SystemExit(f"Produit {code} absent pour le sol {sol}")
    name = names[-1]  # version la plus récente (P01 < P02)
    print(f"  téléchargement {name} ...", flush=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / name
    path.write_bytes(http_get(folder + name))
    return path


def ltst_hours(s: str) -> float | None:
    try:
        hh, mm, ss = s.split(" ")[1].split(":")
        return int(hh) + int(mm) / 60 + float(ss) / 3600
    except (IndexError, ValueError):
        return None


def num(v: str) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if x >= MISSING or math.isnan(x) else x


def read_series(path: Path, value_fn) -> list[tuple[float, float]]:
    """[(heure LTST, valeur)] en ignorant les valeurs manquantes."""
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            h = ltst_hours(row.get("LTST", ""))
            v = value_fn(row)
            if h is not None and v is not None:
                out.append((h, v))
    return out


def air_temp(row):
    vals = [num(row.get(f"ATS_LOCAL_TEMP{i}")) for i in range(1, 6)]
    vals = [v for v in vals if v is not None and 100 < v < 350]
    return statistics.median(vals) if vals else None


def ground_temp(row):
    up = num(row.get("UPWARD_LW_IRRADIANCE"))
    return (up / SIGMA) ** 0.25 if up and up > 0 else None


def hourly(series):
    bins = defaultdict(list)
    for h, v in series:
        bins[int(h) % 24].append(v)
    return {h: statistics.fmean(v) for h, v in sorted(bins.items())}


def minute_means(series):
    """Moyennes sur 1 minute : le vent 'max' n'est pas une rafale d'une seconde."""
    bins = defaultdict(list)
    for h, v in series:
        bins[int(h * 60)].append(v)
    return [(m / 60.0, statistics.fmean(v)) for m, v in sorted(bins.items())]


def window(series, a, b):
    return [v for h, v in series if a <= h < b]


def r(x, n=1):
    return None if x is None else round(x, n)


def summarize_sol(sol: int) -> dict:
    s = {
        "ATS": read_series(fetch_csv(sol, "ATS"), air_temp),
        "PS": read_series(fetch_csv(sol, "PS"), lambda row: num(row.get("PRESSURE"))),
        "WS": read_series(fetch_csv(sol, "WS"), lambda row: num(row.get("HORIZONTAL_WIND_SPEED"))),
        "WD": read_series(fetch_csv(sol, "WS"), lambda row: num(row.get("WIND_DIRECTION"))),
        "TIRS": read_series(fetch_csv(sol, "TIRS"), ground_temp),
    }
    k2c = lambda k: None if k is None else k - 273.15
    t = [v for _, v in s["ATS"]]
    g = [v for _, v in s["TIRS"]]
    p = [v for _, v in s["PS"]]
    ws_1min = minute_means(s["WS"])
    w = [v for _, v in ws_1min]
    gust = max((v for _, v in s["WS"]), default=None)
    a, b = EVA_WINDOW_LTST
    tw, ww = window(s["ATS"], a, b), window(ws_1min, a, b)
    h_t, h_p, h_w, h_g = hourly(s["ATS"]), hourly(s["PS"]), hourly(s["WS"]), hourly(s["TIRS"])
    earth = SOL0_UTC + timedelta(days=sol * SOL_DAYS)
    return {
        "sol": sol,
        "date_terre_approx": earth.date().isoformat(),
        "air_temp_c": {"min": r(k2c(min(t))) if t else None, "max": r(k2c(max(t))) if t else None},
        "sol_temp_brillance_c": {"min": r(k2c(min(g))) if g else None, "max": r(k2c(max(g))) if g else None},
        "pression_pa": {"moyenne": r(statistics.fmean(p)) if p else None},
        "vent_m_s": {"moyen": r(statistics.fmean(w)) if w else None, "max": r(max(w)) if w else None,
                     "rafale_1s_max": r(gust), "note": "moyen et max sur des moyennes d'une minute"},
        "creneau_eva_ltst": list(EVA_WINDOW_LTST),
        "creneau_eva": {
            "air_temp_c_moyenne": r(k2c(statistics.fmean(tw))) if tw else None,
            "vent_m_s_moyen": r(statistics.fmean(ww)) if ww else None,
            "vent_m_s_max": r(max(ww)) if ww else None,
        },
        "horaire": [
            {"ltst_h": h,
             "air_temp_c": r(k2c(h_t.get(h))),
             "sol_temp_c": r(k2c(h_g.get(h))),
             "pression_pa": r(h_p.get(h)),
             "vent_m_s": r(h_w.get(h))}
            for h in range(24)
        ],
        "mesures": {k: len(v) for k, v in s.items()},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sols", default="300-302", help="plage de sols Perseverance, ex. 300-302")
    args = ap.parse_args()
    a, b = map(int, args.sols.split("-"))

    sols = []
    for sol in range(a, b + 1):
        print(f"Sol {sol}")
        sols.append(summarize_sol(sol))
        x = sols[-1]
        print(f"  air {x['air_temp_c']['min']} / {x['air_temp_c']['max']} °C, "
              f"pression {x['pression_pa']['moyenne']} Pa, vent max {x['vent_m_s']['max']} m/s")

    source = {
        "nom": "Mars 2020 Perseverance MEDA (PDS Atmospheres Node)",
        "url": BASE,
        "produits": [c for _, c in PRODUCTS.values()],
        "sols": [a, b],
        "recupere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    notes = {
        "lieu_mesure": "Cratère Jezero (Perseverance) : mesure locale",
        "avertissement": "Mesures réelles d'un sol passé, rejouées pour la démonstration : ce n'est pas une prévision.",
        "methode": "Air : médiane des 5 capteurs ATS. Sol : température de brillance (rayonnement IR montant, "
                   "émissivité supposée = 1). Date terrestre approximative (sol 0 = 2021-02-18).",
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    full = {"source": source, **notes, "sols": sols}
    (OUT_DIR / f"meda_sols_{a}_{b}.json").write_text(json.dumps(full, indent=2, ensure_ascii=False), encoding="utf-8")
    latest = {"source": source, **notes, **sols[-1], "fichier_detail": f"meda_sols_{a}_{b}.json"}
    (OUT_DIR / "meda_summary.json").write_text(json.dumps(latest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> data/meteo/meda_sols_{a}_{b}.json et data/meteo/meda_summary.json")


if __name__ == "__main__":
    main()
