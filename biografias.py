"""Liga cada jogador ao seu artigo na Wikipédia (para a biografia exibida no app).

O Wikidata guarda o id do jogador na NBA.com (propriedade P3647), o mesmo person_id do
dataset. Isso dá o artigo exato, sem confundir homônimos. Adiciona a jogadores.csv as
colunas wiki_pt e wiki_en (títulos dos artigos) e atualiza apps-script/dados_jogadores.html.

Uso (depois de preparar_dados.py):
  python biografias.py
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

SPARQL = "https://query.wikidata.org/sparql"
AGENTE = "AgenteNBA/1.0 (https://github.com; dados de biografia)"
LOTE = 300

CONSULTA = """
SELECT ?id ?pt ?en WHERE {{
  VALUES ?id {{ {ids} }}
  ?item wdt:P3647 ?id .
  OPTIONAL {{ ?pt schema:about ?item ; schema:isPartOf <https://pt.wikipedia.org/> }}
  OPTIONAL {{ ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }}
}}"""


def _titulo(url: str | None) -> str:
    """'https://pt.wikipedia.org/wiki/Stephen_Curry' -> 'Stephen Curry'."""
    if not url:
        return ""
    return urllib.parse.unquote(url.rsplit("/wiki/", 1)[1]).replace("_", " ")


def titulos_wikipedia(ids: list[int]) -> pd.DataFrame:
    linhas = []
    for i in range(0, len(ids), LOTE):
        lote = " ".join(f'"{x}"' for x in ids[i:i + LOTE])
        url = SPARQL + "?" + urllib.parse.urlencode({"query": CONSULTA.format(ids=lote)})
        req = urllib.request.Request(url, headers={"Accept": "application/sparql-results+json", "User-Agent": AGENTE})
        with urllib.request.urlopen(req, timeout=120) as r:
            dados = json.load(r)["results"]["bindings"]
        for b in dados:
            linhas.append({
                "person_id": int(b["id"]["value"]),
                "wiki_pt": _titulo(b.get("pt", {}).get("value")),
                "wiki_en": _titulo(b.get("en", {}).get("value")),
            })
        print(f"  ... {min(i + LOTE, len(ids))}/{len(ids)} jogadores consultados", flush=True)
        time.sleep(1)  # educado com o serviço público do Wikidata
    # Um id pode aparecer repetido se houver mais de um artigo; fica o primeiro
    return pd.DataFrame(linhas, columns=["person_id", "wiki_pt", "wiki_en"]).drop_duplicates("person_id")


def adicionar_wikipedia(jogadores: pd.DataFrame) -> pd.DataFrame:
    wiki = titulos_wikipedia(jogadores["person_id"].astype(int).tolist())
    jogadores = jogadores.drop(columns=["wiki_pt", "wiki_en"], errors="ignore")
    jogadores = jogadores.merge(wiki, on="person_id", how="left")
    jogadores[["wiki_pt", "wiki_en"]] = jogadores[["wiki_pt", "wiki_en"]].fillna("")
    com_pt = (jogadores["wiki_pt"] != "").sum()
    com_algum = ((jogadores["wiki_pt"] != "") | (jogadores["wiki_en"] != "")).sum()
    print(f"Biografias: {com_pt} com artigo em português, {com_algum} com algum artigo, de {len(jogadores)} jogadores")
    return jogadores


def main() -> None:
    raiz = Path(__file__).parent
    csv = raiz / "saida" / "jogadores.csv"
    jogadores = adicionar_wikipedia(pd.read_csv(csv))
    jogadores.to_csv(csv, index=False)
    (raiz / "apps-script" / "dados_jogadores.html").write_text(csv.read_text(encoding="utf-8"), encoding="utf-8")


if __name__ == "__main__":
    main()
