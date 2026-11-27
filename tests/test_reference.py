"""Garde-fou permanent sur tests/reference/ (spec, sections 10.2 et 10.3).

Les fichiers de référence sont générés une fois depuis le code TypeScript, puis servent de
vérité aux tests de parité. Ce test détecte une suppression ou une troncature accidentelle.
"""

import json
from pathlib import Path

import pytest

REFERENCE = Path(__file__).resolve().parent / "reference"

# Table 10.2 de la spec, plus les fichiers de cas limites ajoutés en phase 0.
FICHIERS_EXIGES = [
    "similarite.json",
    "compare_fields.json",
    "syracuse.json",
    "sudoc.json",
    "ecarts.json",
    "unimarc.txt",
    "export.xml",
    "export.csv",
    "export.txt",
]
FICHIERS_CAS_LIMITES = [
    "syracuse_cas_limites.json",
    "sudoc_cas_limites.json",
    "ecarts_cas_limites.json",
    "unimarc_cas_limites.txt",
    "export_decisions.json",
]


@pytest.mark.parametrize("nom", FICHIERS_EXIGES + FICHIERS_CAS_LIMITES)
def test_fichier_de_reference_present_et_non_vide(nom):
    chemin = REFERENCE / nom
    assert chemin.is_file(), f"{nom} manque dans tests/reference/"
    assert chemin.stat().st_size > 0, f"{nom} est vide"


def test_similarite_contient_au_moins_30_paires():
    paires = json.loads((REFERENCE / "similarite.json").read_text(encoding="utf-8"))
    assert len(paires) >= 30
    assert all({"a", "b", "score"} <= set(p) for p in paires)


def test_compare_fields_contient_au_moins_60_triplets():
    triplets = json.loads((REFERENCE / "compare_fields.json").read_text(encoding="utf-8"))
    assert len(triplets) >= 60
    assert all({"champ", "syracuse", "sudoc", "statut", "categorie"} <= set(t) for t in triplets)


def test_les_exports_gardent_leurs_octets_caracteristiques():
    csv = (REFERENCE / "export.csv").read_bytes()
    assert csv.startswith(b"\xef\xbb\xbf"), "le CSV doit commencer par un BOM UTF-8"
    xml = (REFERENCE / "export.xml").read_bytes()
    assert xml.startswith(b'<?xml version="1.0" encoding="utf-8"?>')
    assert b"\r" not in xml + csv, "aucune conversion de fins de ligne (voir .gitattributes)"
