# Pago Voice Assistant — Plan de implementare

> Document de context pentru a continua proiectul în orice chat nou.
> Într-un chat nou, spune-i lui Claude: „Citește IMPLEMENTATION_PLAN.md și continuă de la primul pas nebifat."
> Bifează pașii (`[x]`) doar după ce criteriul „Gata când" al pasului e îndeplinit.

---

## 1. Context

**Pago** este o aplicație românească prin care poți plăti facturi și cumpăra RCA (și alte produse, ex. rovinietă). Proiectul este pentru un hackathon.

**Obiectiv:** un asistent vocal conversațional care face plățile mai ușoare, doar prin conversație. Util în special persoanelor cu dexteritate redusă, care greu navighează o aplicație clasică.

**Două tipuri de comportament:**
1. **Reactiv** — comenzi directe: „Plătește factura la gaz", „Cumpără-mi un RCA", „Cât am de plată luna asta?"
2. **Proactiv** — pe baza contextului. Exemplu: „Plec în Turcia" → asistentul verifică ce ai deja (rovinietă, RCA/Carte Verde), ce lipsește, și propune pe rând achizițiile potrivite (inclusiv cartelă/roaming).

---

## 2. Decizii confirmate

- **Platformă:** PWA mobile-first (web gândit pentru telefon, instalabil pe ecranul principal). Aplicație nativă = doar extensie, dacă rămâne timp. Backend-ul rămâne independent de interfață.
- **Echipă:** 2 persoane cu cunoștințe tehnice moderate → cod simplu, explicații pe parcurs, pași mici.
- **Mod de lucru:** **secvențial, fără împărțirea pașilor între cei doi.** Lucrăm împreună, pas cu pas, pe un singur calculator și o singură ramură. Unul „la tastatură" cu Claude, celălalt verifică pe telefon și spune dacă are sens ce vede. Se poate schimba rolul oricând. Nu se lucrează în paralel pe același cod → nu avem conflicte.
- **Timp:** ~12 ore, din care o parte rezervată pentru testare și demo (vezi secțiunea 11).
- **Funcții în demo:** plată facturi, RCA, rovinietă, cartelă/roaming.
- **Scenarii proactive:** Turcia (principal), alte țări de călătorie, termene care expiră, mașină nouă/mutare — în ordinea priorității din secțiunea 11.
- **Voce:** începem cu vocea din browser (Web Speech API + `speechSynthesis`), abstractizată ca să putem face upgrade la voce cloud dacă rămâne timp.
- **Demo:** live pe telefon + înregistrare video de rezervă (plan B).
- **Model LLM:** fără preferință → Claude (`claude-sonnet-5-5`) cu tool calling. **Deschis:** dacă există cheie API Anthropic. Până o avem, agentul rulează cu un model simulat (răspunsuri scriptate), ca să nu blocăm restul.
- **Browser țintă pentru demo:** Chrome pe Android (cel mai bun suport Web Speech API). iPhone/Safari are suport limitat pentru recunoaștere vocală → fallback text. **Deschis:** ce telefon folosiți la demo.

---

## 3. Principii de proiectare

- **Nicio plată fără confirmare explicită.** Asistentul spune suma, destinatarul și produsul, apoi cere un „da" clar. Utilizatorul poate anula oricând.
- **Confirmarea e impusă în cod, nu doar în promptul LLM.** LLM-ul poate doar *pregăti* o plată; **nu vede niciodată token-ul și nu are un tool de confirmare**. Plata se confirmă exclusiv de backend, când utilizatorul apasă **Confirmă** pe ecran sau când backend-ul recunoaște determinist un „da” clar la o plată aflată în așteptare (vezi secțiunea 8).
- **Scenariile proactive sunt reguli declarative** (ex. „călătorie în Turcia" → listă de verificări), nu improvizație a modelului. LLM-ul înțelege intenția și formulează răspunsul; regulile decid ce se verifică.
- **Asistentul nu inventează.** Dacă nu are datele sau regulile pentru ceva, spune asta cinstit.
- **Română ca limbă principală**, răspunsuri scurte, adaptate vorbirii (1–3 propoziții, o singură întrebare pe rând).
- **Accesibilitate:** buton mare de microfon, feedback vizual și audio, transcript vizibil, fără acțiuni care cer precizie la click, alternativă vizuală la fiecare confirmare vocală.
- **Date mock realiste** și o poveste coerentă, ca demo-ul să arate credibil.

---

## 4. Stack propus

| Strat | Alegere | Motiv |
|---|---|---|
| Frontend | React + Vite + TypeScript (PWA) | Rapid, ușor de demonstrat |
| Voce → text (STT) | Web Speech API (`ro-RO`) | Fără costuri/chei; abstractizat |
| Text → voce (TTS) | `speechSynthesis` (voce `ro-RO`) | Idem; abstractizat |
| Backend | Node.js + TypeScript (Fastify sau Express) | Același limbaj ca frontend-ul |
| LLM | Claude (`claude-sonnet-5-5`) cu tool calling, prin Anthropic SDK | Bun la conversație și apeluri de unelte |
| Date | Backend mock în memorie (JSON seed) | Fără bază de date în prototip |
| Teste | Vitest (unitare/integrare) + Playwright (end-to-end) | Acoperă logica, agentul și UI-ul |

---

## 5. Arhitectură

```
[Microfon] → STT → text
                     ↓
              Frontend (React PWA)  ⇄  Backend (Node/TS)
                                         ├─ Agent (LLM + tool calling)
                                         ├─ Motor de scenarii (reguli proactive)
                                         ├─ Strat de confirmare plăți
                                         └─ API Pago simulat (mock)
                     ↓
              răspuns text → TTS → [Difuzor]
```

**Structură de foldere:**
```
PagoHackathon/
  IMPLEMENTATION_PLAN.md
  apps/
    web/            # frontend React (PWA)
    server/         # backend: agent, scenarii, mock Pago
  packages/
    shared/         # tipuri comune (Bill, Policy, Vignette, ToolCall...)
  tests/
    dialogues/      # dialogurile din secțiunea 7, folosite ca teste
    e2e/            # teste end-to-end
```

**Cum se leagă piesele (pe scurt, pentru înțelegere):**
- **Frontend-ul** doar captează vocea, afișează conversația și redă răspunsul. Nu conține logică de plăți.
- **Agentul** primește mesajul și istoricul, iar LLM-ul decide ce *tool* să apeleze (ex. „verifică rovinieta"). Backend-ul execută tool-ul și îi dă rezultatul înapoi LLM-ului, care formulează răspunsul.
- **Motorul de scenarii** conține regulile („pentru Turcia verifică X, Y, Z"). LLM-ul îl apelează ca pe un tool, dar regulile nu depind de el.
- **Stratul de confirmare** e singurul loc care poate muta bani și cere un token generat după acordul utilizatorului.
- **Mock-ul Pago** imită API-ul real, ca să-l putem înlocui mai târziu.

---

## 6. Modelul de date (mock Pago) și povestea din demo

**Entități:**
- **User:** id, nume, telefon, vehicule, țară de reședință.
- **Vehicle:** număr înmatriculare, tip, serie șasiu (simulată).
- **Bill:** id, furnizor (gaz, curent, apă, internet, telefon), sumă, scadență, status (`unpaid` / `paid` / `overdue`).
- **InsurancePolicy:** tip (RCA, Carte Verde), vehicul, valabilitate, țări acoperite.
- **Vignette (rovinietă):** vehicul, valabilitate, tip.
- **Product catalog:** RCA (oferte/prețuri), rovinietă (durate/prețuri), Carte Verde, cartele/pachete roaming.
- **Payment:** id, sumă, produs, status, timestamp.

**Endpoint-uri mock (forma țintă, înlocuibile cu API-ul real):**
- `GET /bills`, `GET /vehicles`, `GET /policies`, `GET /vignettes`, `GET /products?type=...`
- `POST /payments/prepare` (returnează sumar + token de confirmare), `POST /payments/confirm`, `POST /payments/cancel`

**Utilizatorul din demo (date fictive, de ajustat):**
- **Maria Ionescu**, București, mașină: Dacia Logan, `B-123-ABC`.
- **Facturi:**
  - Curent — 187,40 lei, scadentă în 3 zile (`unpaid`)
  - Gaz — 94,20 lei, scadentă acum 2 zile (`overdue`)
  - Apă — 56,00 lei, scadentă în 12 zile (`unpaid`)
  - Internet — 55,00 lei (`paid`)
- **RCA:** valabil încă 6 zile (urmează să expire — **expiră în timpul călătoriei din D3**, intenționat).
- **Carte Verde:** inclusă în RCA, dar fără Turcia `[de verificat: în România Cartea Verde se emite de regulă odată cu RCA-ul; dacă acoperă Turcia depinde de asigurător]`. În mock: câmpul `countriesCovered` al poliței nu conține `TR`.
- **Rovinietă (România):** validă încă 20 de zile — nu e subiectul scenariului Turcia, dar apare la „termene care expiră”.
- **Vinietă Bulgaria:** lipsește (necesară pe ruta spre Turcia cu mașina) `[de verificat]`.
- **Catalog:** RCA 6 luni (230 lei) / 12 luni (410 lei) / 12 luni cu Carte Verde valabilă și în Turcia (450 lei), rovinietă 7 zile / 30 zile / 12 luni, vinietă Bulgaria (week-end / 7 zile = 75 lei / 30 zile), pachet roaming Turcia (7 și 15 zile), cartelă prepay Turcia.
- **Variante de seed** (pentru teste): „totul în regulă", „RCA expirat", „fără facturi".

> Toate sumele și prețurile sunt fictive. La demo se precizează că sunt date de test.

---

## 7. Dialoguri-exemplu (specificația comportamentului)

Aceste dialoguri definesc ce trebuie să facă asistentul și devin teste automate (în `tests/dialogues/`). Sunt exemple de formă și de ton; formularea exactă a LLM-ului poate varia, dar **acțiunile și ordinea lor** trebuie respectate.

> Notă: regulile pentru țările străine (ce acte sunt necesare) trebuie verificate din surse oficiale înainte de demo. Mai jos sunt scenarii de formă, marcate `[de verificat]` unde contează conținutul.

### D1 — Plata unei facturi (reactiv, cu confirmare)
```
User: Plătește factura la curent.
Asistent: Factura la curent este de 187,40 lei, scadentă în 3 zile. O plătesc acum?
User: Da.
Asistent: Gata, am plătit 187,40 lei pentru curent. Mai ai de plată gazul și apa.
```
Verificări: LLM-ul apelează `prepare_payment` înainte de „Da”; „Da” e recunoscut de backend, care apelează `confirm_payment`; LLM-ul nu primește token-ul.

### D2 — Cerere ambiguă
```
User: Plătește o factură.
Asistent: Ai trei facturi neplătite: curent 187,40 lei, gaz 94,20 lei și apă 56 de lei. Pe care vrei s-o plătesc?
User: Cea la gaz.
Asistent: Factura la gaz este de 94,20 lei și e întârziată. O plătesc acum?
User: Nu.
Asistent: Bine, nu am plătit nimic.
```
Verificări: nu se plătește nimic fără alegere; „Nu” e recunoscut de backend și anulează plata în așteptare.

### D3 — Plec în Turcia (proactiv)
```
User: Plec în Turcia săptămâna viitoare.
Asistent: Pot să te ajut să te pregătești. Mașina o iei cu tine?
User: Da.
Asistent: Am verificat trei lucruri. RCA-ul tău expiră în 6 zile, deci în timpul călătoriei, iar Cartea Verde actuală nu acoperă Turcia. Îți lipsește și vinieta pentru Bulgaria. Începem cu RCA-ul? [de verificat: cerințe reale]
User: Da.
Asistent: Un RCA pe 12 luni cu Carte Verde valabilă și în Turcia costă 450 de lei. Îl cumpăr?
User: Da.
Asistent: Gata. Urmează vinieta pentru Bulgaria: 7 zile costă 75 de lei. O cumpăr?
User: Da.
Asistent: Gata. Mai ai nevoie și de internet în Turcia. Îți arăt pachetele de roaming sau o cartelă locală?
```
Ramură alternativă:
```
User: Plec în Turcia săptămâna viitoare.
Asistent: Pot să te ajut să te pregătești. Mașina o iei cu tine?
User: Nu, merg cu avionul.
Asistent: Atunci ai nevoie în principal de internet. Îți arăt pachetele de roaming pentru Turcia?
```
Verificări: apelează `run_trip_checklist("TR", dates, withCar)`; observă că RCA-ul expiră în intervalul călătoriei; propune pe rând, nu toate odată; cere confirmare pentru fiecare plată; fără mașină → nu propune RCA/vinietă.

### D4 — Termen care expiră (proactiv, la deschiderea aplicației)
```
Asistent: Bună, Maria! RCA-ul tău expiră în 6 zile. Vrei să-l reînnoiesc?
User: Da, arată-mi ofertele.
Asistent: Am două oferte: 410 lei pe 12 luni sau 230 de lei pe 6 luni. Care te interesează?
```
Verificări: apare o singură dată per **sesiune** (= de la deschiderea aplicației până la reîncărcarea paginii; ținută în memoria serverului pe `sessionId`); nu cumpără nimic fără alegere și confirmare. Prețurile din D3/D4 trebuie să coincidă cu catalogul din seed.

### D5 — Nu înțelege / date lipsă
```
User: Plătește factura de la... [zgomot]
Asistent: Nu am înțeles bine. Ce factură vrei să plătesc?
```
```
User: Plec în Japonia.
Asistent: Pentru Japonia nu am încă informații despre ce acte sunt necesare, deci nu vreau să-ți dau indicații greșite. Te pot ajuta cu facturile sau cu roamingul.
```
Verificări: țară necunoscută → mesaj cinstit, nu invenții.

### D6 — Siguranță: sumă incertă
```
User: Plătește o sută de lei la gaz.
Asistent: Factura la gaz este de 94,20 lei, nu 100. O plătesc pe cea de 94,20?
```
Verificări: suma plătită vine mereu din date, nu din ce a rostit utilizatorul.

---

## 8. Siguranța plăților și gestionarea erorilor

- **Suma și destinatarul se citesc mereu din backend**, nu din transcriere. Utilizatorul doar alege și confirmă.
- **Cine confirmă (fluxul exact):**
  1. LLM-ul apelează `prepare_payment(items)`. Backend-ul creează o *plată în așteptare* pentru sesiune, cu token, și îi întoarce LLM-ului doar sumarul (sumă, furnizor, produs), **fără token**.
  2. Frontend-ul primește separat plata în așteptare și afișează cardul **Confirmă / Anulează**.
  3. Confirmarea vine pe una din două căi, ambele în backend, fără LLM:
     - butonul **Confirmă** → `POST /payments/confirm` cu token-ul (îl are doar frontend-ul);
     - mesaj vocal/text → **înainte** să ajungă la LLM, backend-ul verifică dacă există o plată în așteptare și dacă mesajul e un „da” clar (listă fixă: „da”, „confirm”, „da, plătește” etc.). Dacă da → confirmă; dacă e „nu”/„anulează” → anulează; altfel plata rămâne în așteptare și mesajul merge la LLM.
  4. LLM-ul primește rezultatul („plata X a fost confirmată/anulată”) și formulează răspunsul.
- **Confirmare explicită:** răspunsuri vagi („poate”, „hmm”, „da, arată-mi ofertele”) **nu** confirmă o plată.
- **Token de confirmare:** valabil o singură dată, expiră după câteva minute, e legat de sumă și produs; orice schimbare invalidează token-ul. O singură plată în așteptare per sesiune; o nouă `prepare_payment` o anulează pe cea veche.
- **Cifre rostite:** transcriptul se afișează mereu pe ecran; la sume sau furnizori ambigui, asistentul reciteşte valoarea din date și cere confirmare.
- **Plată sub un prag vs. peste:** propunere — peste un prag (ex. 500 lei) asistentul cere și confirmare pe ecran (buton), nu doar vocală. Se decide la Pasul 2.
- **Nu înțelege / zgomot:** cere repetarea o singură dată, apoi oferă alternativa pe ecran.
- **Erori de rețea sau LLM:** mesaj prietenos, nicio plată nu rămâne „pe jumătate" (plata e fie confirmată, fie anulată).
- **Prompt injection:** textul din date (ex. numele unui furnizor) nu este niciodată tratat ca instrucțiune.

---

## 9. Tool-urile agentului

Citire (fără efect secundar):
- `list_bills(status?)`
- `get_vehicles()`
- `check_policies(vehicleId)` — RCA / Carte Verde, cu valabilitate și țări
- `check_vignette(vehicleId)`
- `search_products(type, filters)` — RCA, rovinietă, Carte Verde, roaming etc.
- `run_trip_checklist(country, dates?, withCar?)` — motorul de scenarii pentru călătorii; verifică și dacă ceva expiră *în timpul* călătoriei
- `get_expiring_items(days)` — termene care expiră

Acțiune (disponibilă LLM-ului):
- `prepare_payment(items[])` — creează plata în așteptare și întoarce sumarul **fără token**; **nu mută bani**
- `cancel_pending_payment()` — anulează plata în așteptare a sesiunii (anularea e mereu sigură)

**Nu sunt tool-uri ale LLM-ului** (le apelează doar backend-ul/frontend-ul, vezi secțiunea 8):
- `confirm_payment(token)` — butonul Confirmă sau „da” clar recunoscut de backend
- `cancel_payment(token)` — butonul Anulează sau „nu” clar

---

## 10. Plan pe pași

Fiecare pas are: **ce învățăți**, **livrabil**, **Gata când** (checklist) și, unde e cazul, **ce poți arăta**. Nu trecem la pasul următor până nu e „Gata când". La finalul fiecărui pas facem un commit.

### Pas 0 — Setup proiect
**Ce învățăm:** ce e un monorepo, ce face fiecare folder, cum pornești serverul și interfața.
- [x] Confirmăm stack-ul; avem cheia API Anthropic într-un `.env` (neinclus în git) sau decidem modelul simulat. → Deocamdată model simulat (`LLM_MODE=mock`); cheia rămâne întrebare deschisă.
- [x] `git init` (folderul nu e încă repository) + `.gitignore` (cu `.env`, `node_modules`).
- [x] Inițializăm monorepo (workspaces), TypeScript, Vitest. ESLint doar dacă rămâne timp.
- [x] Scripturi: `dev` (web + server împreună, ex. cu `concurrently`), `test`, `build`.
- [x] **Test rapid de voce (20–30 min), pe telefonul real:** o pagină HTML simplă servită prin tunel HTTPS (ngrok / Cloudflare Tunnel) care face STT `ro-RO` și TTS `ro-RO`. Verificăm: telefonul are voce română pentru TTS? STT înțelege cifre („o sută optzeci și șapte”) și „da/nu”? Dacă ceva nu merge, aflăm acum, nu la Pasul 6.

**Gata când:** `npm run dev` pornește web + server; `npm test` rulează un test banal; testul de voce a fost făcut pe telefon și rezultatul notat în jurnal; primul commit făcut.

### Pas 1 — Pachet comun și date mock
**Ce învățăm:** ce sunt tipurile TypeScript și de ce le partajăm între server și frontend; ce e un API simulat.
- [x] Tipurile din `packages/shared` (secțiunea 6).
- [x] Date seed pentru povestea Mariei + variantele de seed.
- [x] Mock Pago: endpoint-urile de citire din secțiunea 6 (cele de plată vin la Pasul 2, împreună cu token-ul).

**Gata când:** teste unitare pe fiecare endpoint (citire, plată reușită, plată a unei facturi deja plătite → eroare); povestea Mariei se vede corect în răspunsuri.

### Pas 2 — Stratul de confirmare plăți
**Ce învățăm:** de ce regulile de siguranță stau în cod, nu în prompt; ce e un token cu expirare.
- [x] `prepare_payment` / `confirm_payment` / `cancel_payment`, plata în așteptare per sesiune.
- [x] Recunoașterea deterministă a lui „da”/„nu” (listă fixă de expresii, testată), aplicată înainte de LLM — vezi secțiunea 8.
- [x] Reguli: token valabil o singură dată, expiră, suma trebuie să coincidă; pragul pentru confirmare pe ecran = **500 lei** (peste 500, doar butonul confirmă).

**Gata când:** teste pentru token reutilizat, expirat, inexistent, sumă modificată, plată dublă; teste pentru „da”, „nu”, „poate”, „da, arată-mi ofertele” (ultimele două nu confirmă); răspunsul lui `prepare_payment` către LLM nu conține token-ul.

### Pas 3 — Agentul (LLM + tool calling), în text
**Ce învățăm:** cum „decide" modelul ce tool să apeleze; cum arată bucla cerere → tool → rezultat → răspuns; ce e promptul de sistem.
- [ ] Prompt de sistem în română (ton scurt, mereu confirmă plățile, nu inventează).
- [ ] Bucla de tool calling cu tool-urile din secțiunea 9.
- [ ] Endpoint `POST /chat` (mesaj + istoric → răspuns).
- [ ] Dialogurile D1, D2, D5, D6 devin teste în `tests/dialogues/`, pe **două niveluri**:
  - **Teste deterministe** (în `npm test`): LLM simulat, cu apeluri de tool scriptate; verifică ordinea tool-urilor și regulile de siguranță. Trebuie să treacă mereu.
  - **Evaluare cu modelul real** (`npm run test:llm`, rulată manual): aceleași dialoguri; verificăm acțiunile, nu formulările. Poate eșua ocazional → ajustăm promptul.

**Gata când:** testele deterministe pentru D1, D2, D5, D6 trec; evaluarea cu modelul real trece cel puțin o dată (dacă avem cheie); nicio plată nu se face fără „da”.

### Pas 4 — Motor de scenarii proactive
**Ce învățăm:** diferența dintre reguli (deterministe) și limbaj (LLM); cum se adaugă o țară nouă fără să schimbi codul agentului.
- [ ] Reguli declarative în fișiere de date, per țară. Prioritate:
  1. Turcia (Carte Verde, rovinietă, roaming/cartelă) — D3
  2. Alte țări de călătorie (aceeași mecanică, reguli diferite)
  3. Termene care expiră — D4
  4. Mașină nouă / mutare
- [ ] Agentul transformă rezultatul într-o conversație: ce ai deja, ce lipsește, propune pe rând.
- [ ] Regulile pentru fiecare țară sunt verificate din surse oficiale sau marcate clar ca „exemplu".

**Gata când:** D3 și D4 trec automat; țară necunoscută → mesajul cinstit din D5; adăugarea unei țări noi nu cere modificări în agent.

### Pas 5 — Interfața PWA mobile-first (text mai întâi)
**Ce învățăm:** ce e o PWA; de ce microfonul cere HTTPS; cum testezi pe telefonul real.
- [ ] Layout vertical pentru telefon, butoane mari, `manifest` + icon pentru instalare pe ecran.
- [ ] Ecran de chat: mesaje, stare „se gândește", carduri pentru facturi, polițe, produse.
- [ ] Card de confirmare plată cu butoane mari **Confirmă / Anulează** (alternativă la voce).
- [ ] Testare pe telefonul real prin tunel HTTPS (ex. ngrok sau Cloudflare Tunnel).

**Gata când:** pe telefon real parcurgi D1 în text, de la mesaj la plată confirmată; (opțional, dacă e timp) test Playwright pe același flux.

### Pas 6 — Voce
**Ce învățăm:** cum funcționează STT/TTS în browser; stările (în așteptare / ascultă / se gândește / vorbește); de ce abstractizăm vocea.
- [ ] Interfețele `SpeechToText` și `TextToSpeech`, cu implementare Web Speech API (`ro-RO`).
- [ ] Buton mare de microfon (apasă o dată = ascultă), indicator vizual, transcript afișat.
- [ ] TTS pentru răspunsuri, cu buton de oprire; răspunsurile pentru voce sunt scurte.
- [ ] Erori: microfon refuzat, browser fără suport, nu s-a înțeles → fallback la text.

**Gata când:** D1 și D3 se parcurg doar cu vocea, pe telefon, în Chrome Android; testul stărilor (cu STT/TTS simulate) trece.

### Pas 7 — Accesibilitate și calitatea conversației
**Ce învățăm:** ce înseamnă accesibilitate concretă (contrast, etichete ARIA, navigare); cum tratezi corecturile și întreruperile.
- [ ] Navigare completă fără mouse, contrast bun, text mare, etichete ARIA.
- [ ] Mod „doar voce": confirmare prin „da/nu" rostit, plus confirmare vizuală pe ecran.
- [ ] Corecturi („nu, factura de apă") și întreruperi.
- [ ] Audit rapid cu Lighthouse/axe.

**Gata când:** un scenariu complet se parcurge doar cu voce; auditul nu are probleme grave.

### Pas 8 — Teste end-to-end și robustețe
**Ce învățăm:** cum testezi un sistem cu LLM; de ce testăm acțiunile, nu formulările exacte.
- [ ] Toate dialogurile D1–D6 rulează automat.
- [ ] Teste de siguranță: prompt injection în numele unui furnizor, cereri de plată fără confirmare, sume modificate.
- [ ] Gestionarea erorilor LLM/rețea (retry, mesaje prietenoase).

**Gata când:** `npm test` trece (deterministic); `npm run test:llm` trece pe D1–D6; `npm run test:e2e` trece dacă am scris teste Playwright; niciun scenariu nu produce plată fără confirmare.

### Pas 9 — Demo hackathon
**Ce învățăm:** cum construiești o poveste de demo care arată valoarea în 2–3 minute.
- [ ] Script de demo: factură simplă → „Plec în Turcia" → accesibilitate doar cu voce.
- [ ] Date seed pregătite pentru demo; fallback text dacă vocea cedează.
- [ ] **Înregistrare video de rezervă** a demo-ului complet.
- [ ] Slide/README: problema, soluția, arhitectura, ce urmează cu API-ul real Pago.

**Gata când:** o repetiție completă, de două ori consecutiv, fără intervenții manuale în cod; video-ul există.

---

## 11. Buget de timp (~12 ore)

| Bloc | Pași | Ore | Notă |
|---|---|---|---|
| 1 | Pas 0 (setup) + Pas 1 (date mock) | ~2h | Include explicații despre structură |
| 2 | Pas 2 (confirmare plăți) + Pas 3 (agent în text) | ~3h | Nucleul proiectului |
| 3 | Pas 4 (scenarii proactive) | ~2h | Turcia întâi |
| 4 | Pas 5 (UI) + Pas 6 (voce) | ~2.5h | Testat pe telefonul real |
| 5 | Pas 7 (accesibilitate) + Pas 8 (teste) | ~1.5h | Doar esențialul |
| Rezervă | Pas 9 (demo + video) | ~1h | Nu o sacrificăm |

**Dacă întârziem, tăiem în ordinea asta:**
1. Scenariul „mașină nouă/mutare"
2. Alte țări în afară de Turcia
3. Termenele care expiră (D4)
4. Auditul extins de accesibilitate

**Nu tăiem niciodată:** confirmarea plăților, scenariul Turcia, vocea, video-ul de rezervă.

---

## 12. Extensii posibile (dacă rămâne timp)

- STT/TTS de calitate mai bună (servicii cloud) pentru română.
- Aplicație nativă (React Native/Expo) peste același backend.
- Mai multe țări și situații în motorul de scenarii.
- Memorarea preferințelor (furnizori preferați, plăți recurente).
- Notificări proactive.
- Integrare cu API-ul real Pago, în loc de mock.

---

## 13. Riscuri și note

- **Web Speech API** merge bine doar în Chrome/Edge și are nevoie de internet; pentru demo folosim Chrome pe Android.
- **Voce română pentru TTS:** depinde de vocile instalate pe telefon (Google TTS). Se verifică la Pasul 0 (testul rapid de voce).
- **Microfonul cere HTTPS** → tunelul (ngrok / Cloudflare Tunnel) se pregătește de la Pasul 0, nu abia la Pasul 5.
- **Teste cu LLM real** nu sunt deterministe → siguranța se testează pe LLM simulat; modelul real se evaluează separat.
- **Timp:** 12 ore sunt strânse; ESLint și Playwright sunt opționale, `packages/shared` poate fi un singur fișier de tipuri.
- **Calitatea recunoașterii în română** poate varia (nume proprii, cifre) → afișăm mereu transcriptul și citim sumele din date.
- **Reguli legale/administrative** (rovinietă, Carte Verde, cerințe pentru Turcia): nu inventăm; verificăm din surse oficiale înainte de demo sau marcăm ca „exemplu".
- **Date fictive:** prețurile și utilizatorul din demo sunt de test; se spune explicit la prezentare.
- **Securitate:** cheia API doar pe server, niciodată în frontend; `.env` în `.gitignore`.
- **Dependența de LLM la demo:** cheie validă, internet stabil; planul B este video-ul de rezervă.

---

## 14. Întrebări deschise

- [ ] Există cheie API Anthropic? (necesară la Pasul 3; altfel model simulat)
- [x] Ce telefon se folosește la demo (Android/iPhone)? → Android 10, Chrome (testat: STT + TTS română merg).
- [ ] Prețurile și datele Mariei din secțiunea 6 sunt ok sau le schimbăm?
- [x] Pragul pentru confirmare suplimentară pe ecran (ex. 500 lei) — se decide la Pasul 2. → **500 lei**: peste această sumă, doar butonul de pe ecran confirmă.
- [ ] Cartea Verde din România acoperă Turcia? Ce trebuie concret pe ruta România → Bulgaria → Turcia (vinietă BG, taxe HGS în Turcia)? — de verificat din surse oficiale înainte de Pasul 4.

---

## 15. Jurnal de progres

> Actualizează după fiecare sesiune: ce s-a făcut, ce decizii s-au luat, ce urmează.

- **2026-11-16 — revizuire plan (înainte de Pasul 0):**
  - Confirmarea plăților: LLM-ul nu mai are `confirm_payment` și nu vede token-ul; confirmă doar backend-ul (buton sau „da” recunoscut determinist). Secțiunile 3, 8, 9, Pas 2 actualizate.
  - D3 aliniat cu datele: RCA-ul expiră în timpul călătoriei; Cartea Verde actuală nu acoperă Turcia; rovinieta românească scoasă din scenariu, adăugată vinieta Bulgaria; ramură „fără mașină”. Rămân `[de verificat]` din surse oficiale.
  - Catalog: adăugat RCA 6 luni (pentru D4) și prețuri explicite, coerente cu D3/D4. „Sesiune” definită pentru D4.
  - Pas 0: `git init`, test rapid de voce pe telefon, tunel HTTPS; ESLint opțional.
  - Teste pe două niveluri: deterministe (LLM simulat) + evaluare cu modelul real (`test:llm`). Playwright opțional.
  - Următorul pas: Pas 0.
- **2026-11-16 — Pas 0 (parțial):**
  - Monorepo gata: `apps/server` (Fastify, `GET /api/health`), `apps/web` (React + Vite, proxy `/api` → `:3001`), `packages/shared` (`formatLei`). `npm run dev`, `npm test` (2 teste), `npm run build` merg.
  - Portul serverului e `SERVER_PORT` (nu `PORT`), ca să nu se ciocnească cu portul web.
  - Pagina de test de voce: `http://localhost:5173/voice-test.html`. Pe PC-ul de dezvoltare (Windows) nu există voce TTS română → trebuie verificat pe telefon.
  - Instalate Git și `cloudflared` (winget). Repo inițializat pe `main`, primele commit-uri făcute.
  - Tunel HTTPS: `npm run dev` + `npm run tunnel` → URL `https://<ceva>.trycloudflare.com` (se schimbă la fiecare pornire). Verificat: pagina și `/api` merg prin tunel.
  - **Test voce pe telefon (Android 10, Chrome 157), prima încercare:**
    - HTTPS, STT și TTS suportate. ✅ Există voce TTS română („română România”).
    - STT: `not-allowed` → microfonul era blocat pentru site; apoi `aborted` (apăsări repetate). Încă nu știm cât de bine recunoaște româna.
    - TTS `interrupted` = vorbirea oprită de noi, nu e o problemă.
    - Pagina de test arată acum explicații clare pentru erori și nu mai pornește ascultarea de două ori.
  - **Test voce, a doua încercare (microfon permis):** ✅ STT înțelege în română atât cuvintele, cât și cifrele. Vocea e confirmată pe Chrome Android → Pasul 0 **gata**.
- **Următorul pas:** Pas 1 (tipuri comune, date seed, mock Pago).
- **2026-11-16 — Pas 1 gata:**
  - `packages/shared`: tipurile (User, Vehicle, Bill, InsurancePolicy, Vignette, TravelService, Product, Payment, PagoData) + ajutoare pentru date (`addDays`, `daysBetween`).
  - `apps/server/src/mock/seed.ts`: povestea Mariei + variantele `all-good`, `rca-expired`, `no-bills`; datele sunt relative la „azi”. Catalogul are prețurile din D3/D4. Furnizorii au nume fictive.
  - `apps/server/src/mock/store.ts`: citire + `executePayment` intern (sumele din date, totul-sau-nimic, factură deja plătită → eroare). Cumpărarea unui produs adaugă poliță / vinietă / roaming.
  - Endpoint-uri: `GET /api/me, /bills?status, /vehicles, /policies, /vignettes, /services, /products?type, /payments`, `POST /api/dev/reset {variant}`. **Nicio rută nu plătește direct** — plățile vin la Pasul 2, cu token.
  - 32 de teste trec; build OK.
- **Următorul pas:** Pas 2 (stratul de confirmare plăți). De decis: pragul pentru confirmare pe ecran.
- **2026-11-16 — Pas 2 gata:**
  - `apps/server/src/payments/intent.ts`: „da”/„nu” recunoscute determinist (listă fixă, pe toată fraza, fără diacritice). „poate”, „hmm”, „da, arată-mi ofertele” → nu confirmă.
  - `apps/server/src/payments/confirmation.ts` (`PaymentConfirmation`): singurul loc care apelează `executePayment`. O plată în așteptare per sesiune; token unic, expiră în 5 min, legat de sesiune + sume; sumă schimbată → `AMOUNT_CHANGED`; peste 500 lei vocea nu confirmă (`SCREEN_CONFIRM_REQUIRED`). `getPendingSummary` (pentru LLM) nu conține token-ul. `handleUserMessage` rulează înainte de LLM.
  - Rute: `POST /api/payments/prepare`, `GET /api/payments/pending`, `POST /api/payments/confirm` (buton), `POST /api/payments/cancel`.
  - 78 de teste trec; build OK; flux verificat și pe serverul pornit.
- **Următorul pas:** Pas 3 (agentul LLM + tool calling, în text). Încă deschis: cheia API Anthropic (altfel model simulat).
