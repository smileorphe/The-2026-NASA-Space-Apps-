"""Modèle d'autonomie simulée — formule UNIQUE du guide (section 5).

Marge = Autonomie disponible − (Temps aller restant + Temps d'observation + Temps de retour)

Modèle pédagogique : ce n'est pas un modèle physique certifié de consommation d'oxygène.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

from . import config


@dataclass
class AutonomyResult:
    autonomy_min: float
    outbound_remaining_min: float
    observation_min: float
    return_min: float
    reserve_min: float
    margin_min: float
    status: str          # "vert" | "orange" | "rouge"
    message: str
    simulated: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


def compute_margin(autonomy_min: float, outbound_remaining_min: float,
                   observation_min: float, return_min: float) -> float:
    return autonomy_min - (outbound_remaining_min + observation_min + return_min)


def status_for(margin_min: float, reserve_min: float = config.RESERVE_MIN,
               caution_buffer_min: float = config.CAUTION_BUFFER_MIN) -> tuple[str, str]:
    if margin_min < reserve_min:
        return "rouge", "Réserve minimale dépassée : retour prioritaire."
    if margin_min < reserve_min + caution_buffer_min:
        return "orange", "Marge réduite : rester prudent, pas d'arrêt supplémentaire long."
    return "vert", "Marge suffisante : poursuivre."


def evaluate(autonomy_min: float, outbound_remaining_min: float, observation_min: float,
             return_min: float, reserve_min: float = config.RESERVE_MIN) -> AutonomyResult:
    for name, v in (("autonomy_min", autonomy_min), ("outbound_remaining_min", outbound_remaining_min),
                    ("observation_min", observation_min), ("return_min", return_min),
                    ("reserve_min", reserve_min)):
        if v < 0:
            raise ValueError(f"{name} ne peut pas être négatif")
    margin = compute_margin(autonomy_min, outbound_remaining_min, observation_min, return_min)
    status, message = status_for(margin, reserve_min)
    return AutonomyResult(autonomy_min, outbound_remaining_min, observation_min, return_min,
                          reserve_min, round(margin, 1), status, message)


def try_add_stop(current: AutonomyResult, extra_stop_min: float) -> dict:
    """Ajout d'un arrêt scientifique : refusé si la marge passe sous la réserve."""
    new = evaluate(current.autonomy_min, current.outbound_remaining_min,
                   current.observation_min + extra_stop_min, current.return_min, current.reserve_min)
    accepted = new.margin_min >= new.reserve_min
    return {
        "accepted": accepted,
        "reason": ("Arrêt accepté." if accepted else
                   f"Arrêt refusé : la marge tomberait à {new.margin_min} min, "
                   f"sous la réserve de {new.reserve_min} min. Retour recommandé."),
        "before": current.to_dict(),
        "after": new.to_dict(),
    }
