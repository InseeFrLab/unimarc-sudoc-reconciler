"""Règle d'or des dépendances internes (spec, section 3.2).

Le cœur métier (`app/metier/`) n'importe rien de la couche web : ni FastAPI, ni Jinja,
ni `app.web`, `app.sessions`, `app.taches`, `app.main`. L'analyse porte sur l'arbre
syntaxique (`ast`), donc sur tous les imports, y compris ceux faits dans une fonction.
Limite connue : les imports dynamiques (`importlib`) ne sont pas vus.
"""

import ast
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parent.parent
DOSSIER_METIER = RACINE / "app" / "metier"

MODULES_EXTERNES_INTERDITS = {"fastapi", "starlette", "uvicorn", "jinja2"}
MODULES_APP_INTERDITS = {"web", "sessions", "taches", "main"}


def _racine_et_reste(nom: str) -> tuple[str, str]:
    racine, _, reste = nom.partition(".")
    return racine, reste


def modules_importes(source: str, chemin_relatif: tuple[str, ...]) -> set[str]:
    """Noms de modules absolus importés par `source` (imports relatifs résolus).

    `chemin_relatif` est le chemin du fichier dans le paquet, par exemple
    `("app", "metier", "x.py")`, nécessaire pour résoudre `from .. import web`.
    """
    paquet = list(chemin_relatif[:-1])
    trouves: set[str] = set()
    for noeud in ast.walk(ast.parse(source)):
        if isinstance(noeud, ast.Import):
            trouves.update(alias.name for alias in noeud.names)
        elif isinstance(noeud, ast.ImportFrom):
            if noeud.level:
                base = paquet[: len(paquet) - (noeud.level - 1)]
                cible = ".".join([*base, *([noeud.module] if noeud.module else [])])
            else:
                cible = noeud.module or ""
            trouves.add(cible)
            # `from app import web` importe le module `app.web`
            trouves.update(f"{cible}.{alias.name}" for alias in noeud.names)
    return trouves


def violations(dossier: Path, racine_paquet: Path) -> list[str]:
    """Liste des imports interdits trouvés dans les fichiers `.py` de `dossier`."""
    problemes: list[str] = []
    for fichier in sorted(dossier.rglob("*.py")):
        relatif = fichier.relative_to(racine_paquet).parts
        for nom in sorted(modules_importes(fichier.read_text(encoding="utf-8"), relatif)):
            racine, reste = _racine_et_reste(nom)
            externe = racine in MODULES_EXTERNES_INTERDITS
            interne = racine == "app" and _racine_et_reste(reste)[0] in MODULES_APP_INTERDITS
            if externe or interne:
                problemes.append(f"{'/'.join(relatif)} importe {nom}")
    return problemes


def test_metier_n_importe_aucune_couche_web():
    assert DOSSIER_METIER.is_dir()
    assert violations(DOSSIER_METIER, RACINE) == []


@pytest.mark.parametrize(
    "instruction",
    [
        "import fastapi",
        "import fastapi.responses",
        "from fastapi import FastAPI",
        "from starlette.requests import Request",
        "import uvicorn",
        "from jinja2 import Environment",
        "import app.web",
        "from app.web import routes",
        "from app import web",
        "from app import sessions",
        "from app.sessions import StockageMemoire",
        "from app.taches import lancer_verification",
        "from app.main import app",
        "from .. import web",
        "from ..sessions import Session",
        "def f():\n    import fastapi",
    ],
)
def test_detecte_chaque_violation(tmp_path, instruction):
    metier = tmp_path / "app" / "metier"
    metier.mkdir(parents=True)
    (metier / "mauvais.py").write_text(instruction + "\n", encoding="utf-8")
    assert violations(metier, tmp_path) != []


@pytest.mark.parametrize(
    "instruction",
    [
        "import re",
        "from app.metier import similarite",
        "from . import similarite",
        "from .modeles import Notice",
        "from .. import config_absente_du_test_mais_autorisee_si_hors_liste",
    ],
)
def test_accepte_les_imports_legitimes(tmp_path, instruction):
    metier = tmp_path / "app" / "metier"
    metier.mkdir(parents=True)
    (metier / "bon.py").write_text(instruction + "\n", encoding="utf-8")
    assert violations(metier, tmp_path) == []
