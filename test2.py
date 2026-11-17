import base64
import datetime
import io
import json
import os
import re
import socket
import sys
import threading
from urllib.parse import quote

from flask import Flask, jsonify, render_template, request
from gtts import gTTS

try:
    from google import genai
    from google.genai import types
except ImportError:
    genai = None
    types = None

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True  # modificările din index.html se văd fără repornire

VERSIUNE = "6"  # apare în terminal și în pagină, ca să vezi că rulează codul nou
PORT = 5000

# ==============================================================================
# 1. CONFIGURARE API
# ==============================================================================
# Cheia NU se scrie în cod. Pune-o într-un fișier .txt în același folder cu app.py
# (de exemplu cheie_gemini.txt). Programul caută singur cheia în fișierele .txt
# din folder; dacă nu găsește, folosește variabila de mediu GEMINI_API_KEY.
FOLDER_APP = os.path.dirname(os.path.abspath(__file__))
REGEX_CHEIE = re.compile(r"(AQ\.[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{20,})")

# Se încearcă pe rând; dacă unul e aglomerat (503) sau indisponibil, trece la următorul.
MODELE_GEMINI = ["gemini-3.5-flash"]  # folosim un singur model

# Ce știm acum despre Gemini; se vede în pagină (sus) și în mesajele din chat.
STARE_GEMINI = {"ok": False, "motiv": "", "model": "", "sursa_cheie": ""}


def citeste_text(cale):
    """Citește un fișier text mic, indiferent cum a fost salvat (UTF-8, UTF-16...)."""
    with open(cale, "rb") as f:
        brut = f.read(8192)
    for codare in ("utf-8-sig", "utf-16"):
        try:
            return brut.decode(codare).replace("\x00", "")
        except UnicodeError:
            pass
    return brut.decode("latin-1").replace("\x00", "")


def cauta_chei(foldere=None, mediu=None):
    """Întoarce lista de chei găsite, ca perechi (cheie, de_unde). Fișierele au prioritate."""
    if foldere is None:
        foldere = [FOLDER_APP, os.path.join(FOLDER_APP, "templates"), os.getcwd()]
    if mediu is None:
        mediu = os.environ

    gasite, vazute = [], set()

    def adauga(cheie, sursa):
        if cheie and cheie not in vazute:
            vazute.add(cheie)
            gasite.append((cheie, sursa))

    for folder in dict.fromkeys(os.path.abspath(f) for f in foldere):
        if not os.path.isdir(folder):
            continue
        nume_fisiere = [
            n for n in os.listdir(folder)
            if os.path.isfile(os.path.join(folder, n))
            and not n.lower().endswith((".py", ".html", ".pyc", ".mp3", ".png", ".jpg"))
            and (n.lower().endswith(".txt") or any(w in n.lower() for w in ("cheie", "key", "gemini")))
        ]
        # întâi fișierele care par făcute special pentru cheie
        nume_fisiere.sort(key=lambda n: (not any(w in n.lower() for w in ("cheie", "key", "gemini")), n.lower()))
        for nume in nume_fisiere:
            try:
                text = citeste_text(os.path.join(folder, nume))
            except OSError:
                continue
            potrivire = REGEX_CHEIE.search(text)
            if potrivire:
                adauga(potrivire.group(1), f"fișierul {nume}")
            elif nume.lower().startswith("cheie_gemini"):
                # cheie cu alt format: luăm prima linie scrisă în fișier
                linii = [l.strip() for l in text.splitlines() if l.strip()]
                if linii:
                    prima = linii[0].split("=", 1)[-1].strip().strip("\"'")
                    if len(prima) >= 20 and " " not in prima:
                        adauga(prima, f"fișierul {nume}")

    din_mediu = str(mediu.get("GEMINI_API_KEY", "")).strip().strip("\"'")
    if len(din_mediu) >= 20 and " " not in din_mediu:
        adauga(din_mediu, "variabila de mediu GEMINI_API_KEY")

    return gasite


def fisiere_txt_din_folder():
    try:
        return sorted(n for n in os.listdir(FOLDER_APP) if n.lower().endswith(".txt"))
    except OSError:
        return []


def explica_eroare(e):
    """Transformă eroarea tehnică de la Google într-o explicație pe înțeles."""
    t = str(e)
    mic = t.lower()
    if isinstance(e, json.JSONDecodeError):
        return "Gemini a răspuns, dar nu în formatul cerut"
    if "api_key_invalid" in mic or "api key not valid" in mic or "api key expired" in mic:
        return "cheia nu este validă (a fost ștearsă sau copiată greșit); fă una nouă în AI Studio"
    if "permission_denied" in mic or t.startswith("403"):
        return "cheia nu are voie să folosească Gemini API (verifică proiectul în AI Studio)"
    if "resource_exhausted" in mic or t.startswith("429"):
        return "ai atins limita de cereri gratuite; mai încearcă peste câteva minute"
    if "unavailable" in mic or t.startswith("503") or "overloaded" in mic:
        return "serverele Gemini sunt aglomerate acum; mai încearcă peste puțin timp"
    if "not_found" in mic or t.startswith("404"):
        return "modelul cerut nu mai este disponibil"
    if any(w in mic for w in ("timeout", "timed out", "deadline")):
        return (f"Gemini nu a răspuns în {SECUNDE_MAXIM} secunde (internet lent, VPN, antivirus "
                "sau firewall care blochează Google, ori servere foarte aglomerate)")
    if any(w in mic for w in ("connect", "timeout", "timed out", "getaddrinfo", "ssl", "network", "proxy")):
        return "nu am putut ajunge la serverele Google (internet, VPN sau firewall)"
    return t[:200]


def e_cheie_gresita(e):
    mic = str(e).lower()
    return "api_key_invalid" in mic or "api key not valid" in mic or "api key expired" in mic


SECUNDE_MAXIM = 20  # cât așteptăm un răspuns de la Gemini înainte să renunțăm


def creeaza_client(cheie):
    """Client Gemini care nu așteaptă la nesfârșit și nu reîncearcă de multe ori."""
    try:
        optiuni = types.HttpOptions(
            timeout=SECUNDE_MAXIM * 1000,
            retry_options=types.HttpRetryOptions(attempts=1),
        )
        return genai.Client(api_key=cheie, http_options=optiuni)
    except Exception:
        try:
            return genai.Client(api_key=cheie, http_options=types.HttpOptions(timeout=SECUNDE_MAXIM * 1000))
        except Exception:
            return genai.Client(api_key=cheie)


CHEI_GASITE = cauta_chei()
client = None

if not genai:
    STARE_GEMINI["motiv"] = (
        "lipsește biblioteca Gemini; rulează în terminal: python -m pip install -U google-genai"
    )
elif not CHEI_GASITE:
    alte = fisiere_txt_din_folder()
    STARE_GEMINI["motiv"] = (
        f"nu am găsit cheia; pune-o într-un fișier cheie_gemini.txt în folderul {FOLDER_APP}"
        + (f" (fișiere .txt găsite acolo, dar fără cheie în ele: {', '.join(alte)})" if alte else " (acolo nu e niciun fișier .txt)")
    )
else:
    client = creeaza_client(CHEI_GASITE[0][0])
    STARE_GEMINI.update(ok=False, motiv="verific conexiunea cu Gemini...", sursa_cheie=CHEI_GASITE[0][1])


def verifica_gemini():
    """Rulat la pornire: face o cerere de probă și spune clar dacă Gemini merge și de ce nu."""
    global client
    if not genai or not CHEI_GASITE:
        print(f"\n[ATENȚIE] Gemini este INACTIV: {STARE_GEMINI['motiv']}\n")
        return

    for cheie, sursa in CHEI_GASITE:
        print(f"[Cheie] Încerc cheia din {sursa} (începe cu {cheie[:6]}..., {len(cheie)} caractere)")
        candidat = creeaza_client(cheie)
        cheie_gresita = False
        ultimul_motiv = ""
        for model in list(MODELE_GEMINI):
            print(f"   - {model}: aștept răspunsul (maximum {SECUNDE_MAXIM} secunde)...", flush=True)
            try:
                candidat.models.generate_content(model=model, contents="Răspunde doar cu: ok")
            except Exception as e:
                ultimul_motiv = explica_eroare(e)
                print(f"   - {model}: NU ({ultimul_motiv})")
                if e_cheie_gresita(e):
                    cheie_gresita = True
                    break
                continue
            # merge: îl punem primul în listă, ca să fie folosit direct
            MODELE_GEMINI.remove(model)
            MODELE_GEMINI.insert(0, model)
            client = candidat
            STARE_GEMINI.update(ok=True, motiv="", model=model, sursa_cheie=sursa)
            print(f"   - {model}: OK")
            print(f"\n[OK] Gemini AI este CONECTAT (cheia din {sursa}, modelul {model}).\n")
            return
        client = candidat
        STARE_GEMINI.update(ok=False, motiv=ultimul_motiv, model="", sursa_cheie=sursa)
        if not cheie_gresita:
            break  # problemă temporară (aglomerație, limită, internet): altă cheie nu ajută

    print(f"\n[ATENȚIE] Gemini NU merge acum: {STARE_GEMINI['motiv']}\n")

azi = datetime.date.today()

FACTURI_CONT = {
    "hidroelectrica": {
        "nume": "Hidroelectrica",
        "serviciu": "Energie electrică",
        "suma": "148 lei",
        "scadenta": (azi + datetime.timedelta(days=4)).strftime("%d.%m.%Y"),
        "status": "neplătită",
    },
    "engie": {
        "nume": "Engie",
        "serviciu": "Gaze naturale",
        "suma": "215 lei",
        "scadenta": (azi + datetime.timedelta(days=1)).strftime("%d.%m.%Y"),
        "status": "neplătită",
    },
    "digi": {
        "nume": "Digi",
        "serviciu": "Internet și TV",
        "suma": "68 lei",
        "scadenta": (azi + datetime.timedelta(days=12)).strftime("%d.%m.%Y"),
        "status": "neplătită",
    },
    "orange": {
        "nume": "Orange",
        "serviciu": "Telefonie mobilă",
        "suma": "55 lei",
        "scadenta": (azi - datetime.timedelta(days=2)).strftime("%d.%m.%Y"),
        "status": "plătită",
    },
}

REGULI_FURNIZORI = {
    "hidroelectrica": (
        "La Hidroelectrica, termenul standard de plată pentru clienții "
        "casnici este de 45 de zile de la emiterea facturii."
    ),
    "engie": (
        "La Engie, factura are un termen de plată standard de 30 de zile "
        "calendaristice de la data emiterii."
    ),
    "digi": (
        "La Digi, facturile se emit la începutul lunii și au termen "
        "scadent până la finalul lunii respective."
    ),
    "orange": (
        "La Orange, termenul de plată este de 14 zile de la data emiterii "
        "facturii."
    ),
}

TARIFE_PAGO = {
    "asigurare_calatorie_ue": "de la 25 lei pentru 7 zile",
    "asigurare_calatorie_non_ue": "de la 45 lei pentru 7 zile",
    "rovinieta": "17 lei pentru 10 zile",
    "rca": "de la 550 lei pe an",
    "asigurare_locuinta": "de la 130 lei pe an",
    "reincarcare_prepay": "de la 25 lei",
}

SITE_PAGO = "https://pago.ro"

CUNOSTINTE_PAGO = """
DESPRE APLICAȚIA PAGO (ROMÂNIA):
- Ce este: Aplicație fintech românească (iOS și Android) pentru
  gestionarea și plata centralizată a cheltuielilor recurente.
- Site oficial: https://pago.ro . Aplicația se descarcă din App Store
  și Google Play.
- Plata facturilor: Peste 400 de furnizori din România (curent,
  gaze, apă, salubritate, internet, telefonie, întreținere).
- Taxe și impozite: Integrare directă cu Ghișeul.ro pentru plata
  impozitelor locale, taxelor și amenzilor de circulație.
- Asigurări: Compară oferte și emite instant polițe RCA, asigurări
  de călătorie, asigurări de locuință (PAD și facultative).
- Auto și drumuri: Rovinietă pentru România, viniete pentru Ungaria
  și Bulgaria, plus notificări automate pentru RCA, ITP și rovinietă.
- Alte servicii: Reîncărcare cartele prepay (Orange, Vodafone,
  Telekom, Digi), transferuri instant către prieteni pe baza
  numărului de telefon (Pago Transfer) și donații către ONG-uri.
- Costuri: Plata facturilor nu are comision bancar. Există un plan
  gratuit și abonamente lunare pentru facturi nelimitate.
- Securitate: Plăți securizate prin parteneri bancari autorizați
  (Banca Transilvania / Visa / Mastercard) și autentificare biometrică.
"""


# ==============================================================================
# 2. CONSTRUCTOR PACHET + REPLICI VOCALE PE RÂND
# ==============================================================================
def construieste_pachet_pago(tara="", este_non_ue=False, cu_masina=False):
    tara_curata = tara.strip().capitalize() if tara else ""
    param_tara = f"?destinatie={quote(tara_curata)}" if tara_curata else ""
    eticheta_dest = f" ({tara_curata})" if tara_curata else ""
    pret_asig = (
        TARIFE_PAGO["asigurare_calatorie_non_ue"]
        if este_non_ue
        else TARIFE_PAGO["asigurare_calatorie_ue"]
    )

    pachet = [
        {
            "titlu": f"Asigurare de călătorie{eticheta_dest}",
            "nume_vocal": "Asigurare de călătorie",
            "pret": pret_asig,
            "descriere": "Urgențe medicale, bagaje și anulare călătorie",
            "url": f"https://pago.ro/asigurare-calatorie{param_tara}",
            "buton": "Configurează asigurarea →",
        },
        {
            "titlu": "Asigurare de locuință",
            "nume_vocal": "Asigurare de locuință",
            "pret": TARIFE_PAGO["asigurare_locuinta"],
            "descriere": "Protecție pentru casă cât timp ești plecat",
            "url": "https://pago.ro/asigurare-locuinta",
            "buton": "Configurează locuință →",
        },
        {
            "titlu": "Reîncărcare cartelă & Roaming",
            "nume_vocal": "Reîncărcare cartelă pentru roaming",
            "pret": TARIFE_PAGO["reincarcare_prepay"],
            "descriere": "Activează rapid minute și internet în străinătate",
            "url": "https://pago.ro/reincarcare-cartela",
            "buton": "Reîncarcă acum →",
        },
    ]

    if cu_masina:
        pachet.insert(
            1,
            {
                "titlu": "Rovinietă online",
                "nume_vocal": "Rovinietă online",
                "pret": TARIFE_PAGO["rovinieta"],
                "descriere": "Emitere instantă înainte de plecarea la drum",
                "url": "https://pago.ro/rovinieta",
                "buton": "Configurează rovinietă →",
            },
        )
        pachet.insert(
            2,
            {
                "titlu": "Asigurare RCA & Carte Verde",
                "nume_vocal": "Asigurare RCA și Carte Verde",
                "pret": TARIFE_PAGO["rca"],
                "descriere": "Compară ofertele și verifică valabilitatea",
                "url": "https://pago.ro/rca",
                "buton": "Configurează RCA →",
            },
        )

    return pachet


def construieste_replici_vocale_pachet(tara, pachet):
    dest = tara.strip().capitalize() if tara else "destinația aleasă"
    replici = [f"Destinația: {dest}. Iată opțiunile din pachetul Pago:"]
    for idx, item in enumerate(pachet, start=1):
        nume = item.get("nume_vocal", item["titlu"])
        replici.append(f"Opțiunea {idx}: {nume}, {item['pret']}.")
    return replici


# ==============================================================================
# 3. LINKURI (se afișează în chat, dar NU se citesc cu voce)
# ==============================================================================
REGEX_URL = re.compile(r"(https?://\S+|www\.\S+|\b[a-z0-9-]+\.(?:ro|com|eu|org|net)\b(?:/\S*)?)", re.IGNORECASE)


def scoate_linkuri_din_text(text):
    """Scoate orice adresă web din text, ca vocea să nu o citească."""
    fara = REGEX_URL.sub("", text)
    fara = re.sub(r"\s+([.,;:!?])", r"\1", fara)   # spații rămase înainte de punctuație
    return re.sub(r"\s{2,}", " ", fara).strip()


def scoate_url_complete(text):
    """Pentru textul de pe ecran: scoate doar adresele întregi (https://...)."""
    fara = re.sub(r"https?://[^\s\"'<>)]+", "", text)
    fara = re.sub(r"\s+([.,;:!?])", r"\1", fara)
    return re.sub(r"\s{2,}", " ", fara).strip()


def curata_linkuri(lista):
    """Păstrează doar linkuri https valide, fără dubluri, maximum 3."""
    rezultat, vazute = [], set()
    for item in lista or []:
        if isinstance(item, str):
            item = {"titlu": "", "url": item}
        if not isinstance(item, dict):
            continue
        url = str(item.get("url", "")).strip()
        if not re.fullmatch(r"https://[^\s\"'<>]+", url) or url in vazute:
            continue
        titlu = str(item.get("titlu", "")).strip() or url.replace("https://", "")
        vazute.add(url)
        rezultat.append({"titlu": titlu, "url": url})
    return rezultat[:3]


# ==============================================================================
# 4. AUDIO (gTTS -> LISTĂ DE SEGMENTE BASE64)
# ==============================================================================
def genereaza_audio_base64(text):
    try:
        fp = io.BytesIO()
        tts = gTTS(text=text, lang="ro")
        tts.write_to_fp(fp)
        fp.seek(0)
        return base64.b64encode(fp.read()).decode("utf-8")
    except Exception:
        return None


def genereaza_lista_audio(replici):
    rezultat = []
    for text in replici:
        text = scoate_linkuri_din_text(text)  # siguranță: niciun link nu ajunge la voce
        if not text:
            continue
        b64 = genereaza_audio_base64(text)
        if b64:
            rezultat.append(b64)
    return rezultat


# ==============================================================================
# 5. LOGICA AI + REZERVĂ LOCALĂ
# ==============================================================================
def construieste_context_cont():
    linii = [f"Data de azi este {azi.strftime('%d.%m.%Y')}."]
    for _, date in FACTURI_CONT.items():
        linii.append(
            f"- {date['nume']} ({date['serviciu']}): "
            f"suma {date['suma']}, scadență {date['scadenta']}, "
            f"status {date['status']}."
        )
    return "\n".join(linii)


def construieste_system_prompt():
    acum = datetime.datetime.now().strftime("%d.%m.%Y, ora %H:%M")
    return f"""
Ești asistentul virtual al aplicației românești Pago și vorbești mereu în română.
Poți răspunde la ORICE întrebare: despre Pago, despre facturile utilizatorului,
despre călătorii, dar și întrebări generale (cultură generală, explicații,
sfaturi, calcule, definiții etc.). Nu refuza întrebările care nu țin de Pago;
răspunde-le normal și prietenos.
Data și ora curentă: {acum}.

Răspunde STRICT cu un obiect JSON valid, cu exact această structură:
{{
  "raspuns": "Textul în română, 2-5 propoziții, care va fi CITIT CU VOCE. Fără Markdown, fără simboluri (*, #, -) și FĂRĂ nicio adresă web.",
  "linkuri": [{{"titlu": "Nume scurt", "url": "https://..."}}],
  "este_calatorie": true sau false,
  "tara": "Numele țării la nominativ (ex: Turcia, Japonia) sau string gol",
  "este_non_ue": true dacă țara e în afara UE/Schengen, altfel false,
  "cu_masina": true dacă utilizatorul menționează mașina/condusul, altfel false
}}

REGULI:
1. DESPRE PAGO: folosește baza de cunoștințe de mai jos.
2. CĂLĂTORII ("este_calatorie": true): spune ce documente îi trebuie unui cetățean
   român (buletin, pașaport, viză) și invită-l să configureze serviciile Pago din
   cardurile afișate sub răspuns.
3. FACTURI: folosește datele din cont și termenul standard al furnizorului.
4. LINKURI: orice adresă web merge DOAR în "linkuri", niciodată în "raspuns".
   Pune linkuri doar când utilizatorul cere un site/link sau când un site oficial
   chiar îl ajută. Folosește doar adrese oficiale, sigure, pe care le cunoști cu
   certitudine (pentru Pago: https://pago.ro). Dacă nu ești sigur, lasă lista goală.
   În "raspuns" poți spune „Ți-am pus linkul mai jos.”
5. Dacă nu știi ceva sigur (de exemplu informații foarte recente), spune sincer
   asta în loc să inventezi.

{CUNOSTINTE_PAGO}

DATELE DIN CONTUL PAGO AL UTILIZATORULUI:
{construieste_context_cont()}
"""


def citeste_json(text):
    """Citește JSON-ul de la Gemini, chiar dacă vine înconjurat de ```json ... ```."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    return json.loads(text)


def raspunde_cu_gemini(intrebare):
    if not client:
        return None

    config = types.GenerateContentConfig(
        system_instruction=construieste_system_prompt(),
        response_mime_type="application/json",
        temperature=0.4,
    )

    date_ai = None
    motiv = ""
    for model in MODELE_GEMINI:
        try:
            raspuns = client.models.generate_content(
                model=model, contents=intrebare, config=config
            )
            date_ai = citeste_json(raspuns.text)
            if not isinstance(date_ai, dict):
                raise ValueError("răspuns în alt format decât cel cerut")
            print(f"[Gemini] Răspuns de la {model}")
            STARE_GEMINI.update(ok=True, motiv="", model=model)
            break
        except Exception as e:
            date_ai = None
            motiv = explica_eroare(e)
            print(f"[Gemini] {model} nu a mers: {motiv}")
            if e_cheie_gresita(e):
                break  # cu o cheie greșită nu merge niciun model

    if date_ai is None:
        STARE_GEMINI.update(ok=False, motiv=motiv or "eroare necunoscută", model="")
        print("[Gemini] Folosesc rezerva locală.")
        return None

    text_brut = str(date_ai.get("raspuns", "")).replace("*", "").replace("#", "")
    linkuri = curata_linkuri(date_ai.get("linkuri", []))

    # dacă Gemini a scăpat totuși un link în text, îl mutăm în lista de linkuri
    for url in re.findall(r"https://[^\s\"'<>)]+", text_brut):
        linkuri = curata_linkuri(linkuri + [url.rstrip(".,;:!?")])
    # pe ecran rămâne textul fără adrese întregi; vocea mai curăță o dată (vezi genereaza_lista_audio)
    text_ecran = scoate_url_complete(text_brut) or "Iată ce am găsit."

    actiuni = []
    replici_vocale = [text_ecran]

    if date_ai.get("este_calatorie"):
        tara = str(date_ai.get("tara", ""))
        actiuni = construieste_pachet_pago(
            tara=tara,
            este_non_ue=bool(date_ai.get("este_non_ue", False)),
            cu_masina=bool(date_ai.get("cu_masina", False)),
        )
        replici_vocale = construieste_replici_vocale_pachet(tara, actiuni)

    return {
        "raspuns": text_ecran,
        "replici_vocale": replici_vocale,
        "actiuni": actiuni,
        "linkuri": linkuri,
    }


def raspunde_local(comanda):
    c = comanda.lower()

    if "ceasul" in c or "ora" in c.split() or "oră" in c.split():
        ora = datetime.datetime.now().strftime("%H:%M")
        txt = f"Este ora {ora}."
        return {"raspuns": txt, "replici_vocale": [txt], "actiuni": [], "linkuri": []}

    if "pago" in c and any(w in c for w in ["site", "link", "pagina", "pagină", "adresa", "adresă"]):
        txt = "Ți-am pus mai jos linkul către site-ul oficial Pago."
        return {
            "raspuns": "Site-ul oficial Pago este pago.ro. Ți-am pus linkul mai jos.",
            "replici_vocale": [txt],
            "actiuni": [],
            "linkuri": [{"titlu": "Site oficial Pago", "url": SITE_PAGO}],
        }

    cuvinte_calatorie = [
        "plec",
        "călătoresc",
        "vacanță",
        "țară",
        "nevoie",
        "acte",
        "documente",
        "pachet",
    ]
    if any(w in c for w in cuvinte_calatorie):
        potrivire = re.search(r"\b(?:în|la|pentru)\s+([a-zăâîșț\-]+)", c)
        tara_detectata = potrivire.group(1).capitalize() if potrivire else ""
        tari_non_ue = [
            "japonia",
            "turcia",
            "egipt",
            "sua",
            "anglia",
            "thailanda",
            "dubai",
            "emirate",
            "moldova",
        ]
        este_non_ue = tara_detectata.lower() in tari_non_ue
        cu_masina = any(w in c for w in ["mașina", "masina", "auto", "conduc"])

        dest_text = (
            f"pentru {tara_detectata}"
            if tara_detectata
            else "pentru destinația aleasă"
        )
        acte_text = (
            "pașaport valabil"
            if este_non_ue
            else "carte de identitate sau pașaport valabil"
        )
        text_ecran = (
            f"Ca cetățean român, {dest_text} ai nevoie de {acte_text}. "
            "Configurează serviciile dorite din cardurile de mai jos."
        )
        actiuni = construieste_pachet_pago(
            tara=tara_detectata,
            este_non_ue=este_non_ue,
            cu_masina=cu_masina,
        )
        replici = construieste_replici_vocale_pachet(tara_detectata, actiuni)

        return {
            "raspuns": text_ecran,
            "replici_vocale": replici,
            "actiuni": actiuni,
            "linkuri": [],
        }

    for f, regula in REGULI_FURNIZORI.items():
        if f in c:
            date = FACTURI_CONT[f]
            txt = (
                f"În contul tău Pago, factura la {date['nume']} de "
                f"{date['suma']} are scadența pe {date['scadenta']}. "
                f"{regula}"
            )
            return {"raspuns": txt, "replici_vocale": [txt], "actiuni": [], "linkuri": []}

    if "pago" in c:
        txt = (
            "Pago este o aplicație fintech românească prin care poți plăti "
            "centralizat facturile la peste 400 de furnizori, taxele de pe "
            "Ghișeul.ro, rovinieta și poți încheia asigurări RCA, de "
            "călătorie sau de locuință."
        )
        return {
            "raspuns": txt,
            "replici_vocale": [txt],
            "actiuni": [],
            "linkuri": [{"titlu": "Site oficial Pago", "url": SITE_PAGO}],
        }

    motiv = STARE_GEMINI["motiv"] or "motiv necunoscut, vezi terminalul"
    txt_ecran = (
        "Nu pot folosi Gemini acum, așa că știu doar ora, facturile, pachetele "
        f"de călătorie și informații despre Pago. Motivul: {motiv}."
    )
    txt_voce = "Nu pot folosi inteligența artificială acum. Motivul este scris în chat."
    return {
        "raspuns": txt_ecran,
        "replici_vocale": [txt_voce],
        "actiuni": [],
        "linkuri": [],
    }


# ==============================================================================
# 6. RUTE WEB
# ==============================================================================
@app.route("/")
def index():
    raspuns = app.make_response(render_template("index.html"))
    raspuns.headers["Cache-Control"] = "no-store"  # browserul ia mereu pagina nouă
    return raspuns


@app.route("/api/stare", methods=["GET"])
def stare():
    return jsonify(
        {
            "versiune": VERSIUNE,
            "gemini": client is not None and STARE_GEMINI["ok"],
            "motiv": STARE_GEMINI["motiv"],
            "model": STARE_GEMINI["model"],
        }
    )


@app.route("/api/facturi", methods=["GET"])
def get_facturi():
    return jsonify(FACTURI_CONT)


@app.route("/api/plateste/<furnizor>", methods=["POST"])
def plateste_factura(furnizor):
    if furnizor in FACTURI_CONT:
        FACTURI_CONT[furnizor]["status"] = "plătită"
        nume = FACTURI_CONT[furnizor]["nume"]
        mesaj = f"Am înregistrat plata pentru factura ta {nume}. Ești la zi!"
        return jsonify(
            {
                "ok": True,
                "mesaj": mesaj,
                "audio_lista": genereaza_lista_audio([mesaj]),
                "facturi": FACTURI_CONT,
            }
        )
    return jsonify({"ok": False}), 404


@app.route("/api/intreaba", methods=["POST"])
def intreaba():
    data = request.get_json(silent=True) or {}
    intrebare = str(data.get("intrebare", "")).strip()

    if not intrebare:
        return jsonify(
            {
                "raspuns": "Nu am auzit nicio întrebare.",
                "audio_lista": [],
                "actiuni": [],
                "linkuri": [],
            }
        )

    if "plătește" in intrebare.lower() or "plateste" in intrebare.lower():
        for cheie, info in FACTURI_CONT.items():
            if cheie in intrebare.lower() and info["status"] == "neplătită":
                FACTURI_CONT[cheie]["status"] = "plătită"
                raspuns = (
                    f"Am achitat factura la {info['nume']} în valoare de "
                    f"{info['suma']}. Statusul a fost actualizat în contul tău."
                )
                return jsonify(
                    {
                        "raspuns": raspuns,
                        "audio_lista": genereaza_lista_audio([raspuns]),
                        "facturi": FACTURI_CONT,
                        "actiuni": [],
                        "linkuri": [],
                    }
                )

    rezultat = raspunde_cu_gemini(intrebare)
    if not rezultat:
        rezultat = raspunde_local(intrebare)

    replici = rezultat.get("replici_vocale", [rezultat["raspuns"]])
    audio_lista = genereaza_lista_audio(replici)

    return jsonify(
        {
            "raspuns": rezultat["raspuns"],
            "actiuni": rezultat.get("actiuni", []),
            "linkuri": rezultat.get("linkuri", []),
            "audio_lista": audio_lista,
            "facturi": FACTURI_CONT,
        }
    )


def port_ocupat(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def porneste():
    if port_ocupat(PORT):
        print(
            f"\n[STOP] Pe portul {PORT} rulează deja un alt program (probabil un app.py vechi).\n"
            "Oprește tot ce e Python cu comanda de mai jos, apoi pornește din nou:\n"
            "    Get-Process python* | Stop-Process -Force\n"
        )
        sys.exit(1)
    print(f"\nAsistent Pago, versiunea {VERSIUNE}")
    print("Verific Gemini în fundal; pagina poate fi deschisă deja.\n")
    threading.Thread(target=verifica_gemini, daemon=True).start()
    print(f"Deschide în browser: http://127.0.0.1:{PORT}")
    app.run(debug=False, port=PORT)


if __name__ == "__main__":
    porneste()
