"""Récupère un vrai événement de météo spatiale dans NASA DONKI et l'enregistre
pour le rejouer hors ligne avec le bouton « Simuler un imprévu ».

L'imprévu est construit sur un événement SEP (flux de particules solaires) : c'est
lui qui menace un astronaute en sortie. L'éruption associée est retrouvée via les
notifications DONKI (l'endpoint FLR de api.nasa.gov renvoie 404 depuis fin 2026).

Usage (depuis backend/) :
    python scripts/fetch_donki.py                       # défaut : tempête de mai 2024
    python scripts/fetch_donki.py --start 2024-10-01 --end 2024-10-10

Clé API : variable d'environnement NASA_API_KEY (gratuite sur api.nasa.gov),
sinon DEMO_KEY (limitée à ~30 requêtes/heure).

Sorties :
    data/donki_raw/<type>_<start>_<end>.json   réponses brutes
    data/incidents/solar_particles_<date>.json  imprévu servi par GET /incidents/{id}
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://api.nasa.gov/DONKI"
BACKEND_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = BACKEND_DIR / "data" / "donki_raw"
INCIDENTS_DIR = BACKEND_DIR / "data" / "incidents"

CLASS_RANK = {"A": 0, "B": 1, "C": 2, "M": 3, "X": 4}
CLASS_RE = re.compile(r"\b([CMX])(\d+(?:\.\d+)?)\b")


def fetch(kind: str, start: str, end: str, api_key: str, extra: dict | None = None,
          required: bool = True) -> list:
    params = {"startDate": start, "endDate": end, "api_key": api_key, **(extra or {})}
    url = f"{BASE}/{kind}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "eva-planner-hackathon/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 429 and not required:
            print("(quota DEMO_KEY dépassé, ignoré)", end=" ")
            return []
        if e.code == 429:
            sys.exit("Quota DONKI dépassé (DEMO_KEY). Créez une clé gratuite sur api.nasa.gov "
                     "et définissez NASA_API_KEY.")
        if not required:
            print(f"(indisponible : HTTP {e.code})", end=" ")
            return []
        raise
    return json.loads(body) if body.strip() else []


def parse_time(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(s[:19] if fmt.endswith("%S") else s[:16], fmt)
        except ValueError:
            continue
    return None


def class_strength(c: str) -> float:
    m = CLASS_RE.match(c or "")
    return CLASS_RANK[m.group(1)] + float(m.group(2)) / 10.0 if m else -1.0


def flare_class_near(t: datetime | None, flr_notes: list, hours: float = 6.0) -> str | None:
    """Classe d'éruption la plus forte citée dans les notifications FLR proches de t."""
    if t is None:
        return None
    best = None
    for n in flr_notes:
        nt = parse_time(n.get("messageIssueTime"))
        if nt is None or abs(nt - t) > timedelta(hours=hours):
            continue
        for letter, val in CLASS_RE.findall(n.get("messageBody", "")):
            c = f"{letter}{val}"
            if best is None or class_strength(c) > class_strength(best):
                best = c
    return best


def linked_flare_time(sep: dict) -> datetime | None:
    for e in sep.get("linkedEvents") or []:
        aid = e.get("activityID", "")
        if "-FLR-" in aid:
            return parse_time(aid.split("-FLR-")[0])
    return None


def build_incident(sep: dict, flare_class: str | None, start: str, end: str) -> dict:
    date = (sep.get("eventTime") or "inconnu")[:10]
    strong = flare_class is not None and flare_class.startswith("X")
    return {
        "id": f"solar_particles_{date}",
        "type": "flux_particules_solaires",
        "titre": "Flux de particules solaires" + (f" après une éruption {flare_class}" if flare_class else ""),
        "niveau": "rouge",
        "message": "Flux de particules solaires annoncé. Interrompre la sortie et rejoindre "
                   "l'habitat ou l'abri le plus proche par le chemin connu.",
        "action_recommandee": "retour_immediat",
        "simulation": True,
        "avertissement": "Événement réel enregistré par la NASA (DONKI), rejoué ici comme "
                         "scénario de démonstration. Il n'a pas été mesuré à Jezero.",
        "evenement_reel": {
            "sepID": sep.get("sepID"),
            "eventTime": sep.get("eventTime"),
            "instruments": [i.get("displayName") for i in sep.get("instruments") or []],
            "eruption_associee": {
                "activityID": next((e["activityID"] for e in sep.get("linkedEvents") or []
                                    if "-FLR-" in e.get("activityID", "")), None),
                "classe_max_notifiee": flare_class,
                "classe_X": strong,
            },
            "link": sep.get("link"),
            "alertes": [n.get("messageURL") for n in sep.get("sentNotifications") or []],
        },
        "source": {
            "nom": "NASA DONKI (Space Weather Database Of Notifications, Knowledge, Information)",
            "url": f"{BASE}/SEP?startDate={start}&endDate={end}",
            "recupere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default="2024-05-08", help="AAAA-MM-JJ (défaut : tempête de mai 2024)")
    ap.add_argument("--end", default="2024-05-15", help="AAAA-MM-JJ")
    ap.add_argument("--refresh", action="store_true",
                    help="ignorer le cache data/donki_raw et rappeler l'API")
    args = ap.parse_args()
    api_key = os.environ.get("NASA_API_KEY", "DEMO_KEY")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    INCIDENTS_DIR.mkdir(parents=True, exist_ok=True)

    queries = {
        "SEP": ("SEP", {}, True),
        "CME": ("CME", {}, False),
        "notifications_FLR": ("notifications", {"type": "FLR"}, False),
    }
    data = {}
    for name, (kind, extra, required) in queries.items():
        out = RAW_DIR / f"{name}_{args.start}_{args.end}.json"
        print(f"DONKI {name} {args.start} -> {args.end} ...", end=" ", flush=True)
        if out.exists() and not args.refresh:
            cached = json.loads(out.read_text(encoding="utf-8"))
            if cached:
                data[name] = cached
                print(f"{len(cached)} éléments (cache {out.relative_to(BACKEND_DIR)})")
                continue
        data[name] = fetch(kind, args.start, args.end, api_key, extra, required)
        if data[name]:  # on n'enregistre jamais une réponse vide (quota, erreur)
            out.write_text(json.dumps(data[name], indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"{len(data[name])} éléments -> {out.relative_to(BACKEND_DIR)}")

    if not data["SEP"]:
        sys.exit("Aucun flux de particules (SEP) sur cette période : essayez d'autres dates.")

    # On retient le SEP associé à l'éruption la plus forte.
    scored = [(sep, flare_class_near(linked_flare_time(sep), data["notifications_FLR"]))
              for sep in data["SEP"]]
    sep, flare_class = max(scored, key=lambda p: class_strength(p[1] or ""))

    incident = build_incident(sep, flare_class, args.start, args.end)
    out = INCIDENTS_DIR / f"{incident['id']}.json"
    out.write_text(json.dumps(incident, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nImprévu retenu : {incident['titre']} ({sep.get('eventTime')})")
    print(f"-> {out.relative_to(BACKEND_DIR)}  (servi par GET /incidents/{incident['id']})")


if __name__ == "__main__":
    main()
