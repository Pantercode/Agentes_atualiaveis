"""Gera os CSVs que alimentam a planilha do Apps Script.

Lê o dataset do Kaggle (wyattowalsh/basketball) e produz:
  saida/jogadores.csv     -> cadastro de cada jogador + URL da foto
  saida/estatisticas.csv  -> performance por jogador e temporada (calculada do play-by-play)

Uso:
  python preparar_dados.py <pasta_do_dataset>

A pasta deve conter csv/common_player_info.csv e csv/play_by_play.csv.
"""

import sys
from pathlib import Path

import pandas as pd

from biografias import adicionar_wikipedia

FOTO_URL = "https://cdn.nba.com/headshots/nba/latest/1040x760/{}.png"

# Códigos de evento (eventmsgtype) do play-by-play da NBA
ARREMESSO_CERTO, ARREMESSO_ERRADO, LANCE_LIVRE, REBOTE, TURNOVER = 1, 2, 3, 4, 5

PBP_COLUNAS = [
    "game_id", "eventmsgtype", "homedescription", "visitordescription",
    "person1type", "player1_id", "player2_id", "player3_id",
]


def temporada(game_id: pd.Series) -> pd.Series:
    """'0021900001' -> '2019-20'."""
    ano = game_id.str[3:5].astype(int)
    ano = ano.where(ano >= 46, ano + 100) + 1900
    return ano.astype(str) + "-" + ((ano + 1) % 100).astype(str).str.zfill(2)


def agregar_pbp(caminho: Path) -> pd.DataFrame:
    partes = []
    for bloco in pd.read_csv(caminho, usecols=PBP_COLUNAS, dtype={"game_id": str},
                             chunksize=1_000_000, low_memory=False):
        bloco["game_id"] = bloco["game_id"].str.zfill(10)
        # Apenas temporada regular (2) e playoffs (4)
        bloco = bloco[bloco["game_id"].str[2].isin(["2", "4"])]
        desc = (bloco["homedescription"].fillna("") + " " +
                bloco["visitordescription"].fillna("")).str.upper()
        tipo = bloco["eventmsgtype"]
        tres = desc.str.contains("3PT")

        eventos = []

        def add(mask, col_jogador, **stats):
            df = bloco.loc[mask, ["game_id", col_jogador]].rename(columns={col_jogador: "person_id"})
            for k, v in stats.items():
                df[k] = v[mask] if isinstance(v, pd.Series) else v
            eventos.append(df)

        certo = tipo == ARREMESSO_CERTO
        errado = tipo == ARREMESSO_ERRADO
        ll = tipo == LANCE_LIVRE
        ll_certo = ll & ~desc.str.contains("MISS")

        add(certo, "player1_id", fgm=1, fga=1, fg3m=tres.astype(int), fg3a=tres.astype(int),
            pts=2 + tres.astype(int))
        add(errado, "player1_id", fga=1, fg3a=tres.astype(int))
        add(ll, "player1_id", fta=1, ftm=ll_certo.astype(int), pts=ll_certo.astype(int))
        # person1type 4/5 = jogador (rebotes de equipe têm outro tipo)
        add((tipo == REBOTE) & bloco["person1type"].isin([4, 5]), "player1_id", reb=1)
        add(certo & (bloco["player2_id"] > 0), "player2_id", ast=1)
        add((tipo == TURNOVER) & (bloco["player1_id"] > 0), "player1_id", tov=1)
        add((tipo == TURNOVER) & (bloco["player2_id"] > 0), "player2_id", stl=1)
        add(errado & (bloco["player3_id"] > 0), "player3_id", blk=1)

        ev = pd.concat(eventos, ignore_index=True).fillna(0)
        partes.append(ev.groupby(["person_id", "game_id"], as_index=False).sum())
        print(f"  ... {sum(len(p) for p in partes):,} linhas jogador-jogo", flush=True)

    jogos = pd.concat(partes).groupby(["person_id", "game_id"], as_index=False).sum()
    jogos["temporada"] = temporada(jogos["game_id"])
    jogos["fase"] = jogos["game_id"].str[2].map({"2": "Regular", "4": "Playoffs"})

    stats = ["pts", "reb", "ast", "stl", "blk", "tov", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta"]
    res = (jogos.groupby(["person_id", "temporada", "fase"])
           .agg(jogos=("game_id", "nunique"), **{s: (s, "sum") for s in stats})
           .reset_index())
    res[stats] = res[stats].astype(int)
    res["person_id"] = res["person_id"].astype(int)
    return res


def main(base: Path) -> None:
    saida = Path(__file__).parent / "saida"
    saida.mkdir(exist_ok=True)

    info = pd.read_csv(base / "csv" / "common_player_info.csv")
    jogadores = pd.DataFrame({
        "person_id": info["person_id"],
        "nome": info["display_first_last"],
        "posicao": info["position"],
        "altura": info["height"],
        "peso": info["weight"],
        "pais": info["country"],
        "time": (info["team_city"].fillna("") + " " + info["team_name"].fillna("")).str.strip(),
        "sigla_time": info["team_abbreviation"],
        "camisa": info["jersey"],
        "de": info["from_year"].astype("Int64"),
        "ate": info["to_year"].astype("Int64"),
        "draft": info["draft_year"],
        "top75": info["greatest_75_flag"],
        "foto": info["person_id"].map(FOTO_URL.format),
    })

    print("Agregando play-by-play (pode levar alguns minutos)...")
    est = agregar_pbp(base / "csv" / "play_by_play.csv")
    est = est[est["person_id"].isin(jogadores["person_id"])]
    jogadores = jogadores[jogadores["person_id"].isin(est["person_id"])]

    # Médias de carreira (temporada regular): ordenam a galeria e aparecem nos cards
    carreira = est[est["fase"] == "Regular"].groupby("person_id")[["jogos", "pts", "reb", "ast"]].sum()
    for col, s in [("ppg", "pts"), ("rpg", "reb"), ("apg", "ast")]:
        carreira[col] = (carreira[s] / carreira["jogos"]).round(1)
    jogadores = jogadores.merge(carreira[["jogos", "ppg", "rpg", "apg"]], on="person_id", how="left")
    jogadores = jogadores.sort_values("ppg", ascending=False)

    print("Ligando cada jogador ao artigo da Wikipédia (biografia)...")
    jogadores = adicionar_wikipedia(jogadores)

    jogadores.to_csv(saida / "jogadores.csv", index=False)
    est.sort_values(["person_id", "temporada", "fase"]).to_csv(saida / "estatisticas.csv", index=False)
    print(f"OK: {len(jogadores):,} jogadores, {len(est):,} linhas de estatísticas em {saida}")

    # Cópia dos CSVs como arquivos HTML do projeto Apps Script: o app importa sozinho no 1º acesso
    apps = Path(__file__).parent / "apps-script"
    for nome in ["jogadores", "estatisticas"]:
        texto = (saida / f"{nome}.csv").read_text(encoding="utf-8")
        (apps / f"dados_{nome}.html").write_text(texto, encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
