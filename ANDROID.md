# Pago AI pe telefon (Android, fără Play Store)

Aplicația Android e aplicația web din `apps/web`, împachetată cu **Capacitor 8**. Pe telefon folosește:
- recunoașterea vocală a telefonului (`@capacitor-community/speech-recognition`) — WebView-ul Android nu are Web Speech API;
- vocea telefonului (`@capacitor-community/text-to-speech`), în română;
- amprenta / Face Unlock la butonul **Confirmă plata** (`@capgo/capacitor-native-biometric`).

Serverul (Node + Fastify, portul **3001**) rulează pe laptop; telefonul îi trimite cereri prin Wi-Fi sau prin cablu.
Siguranța plăților rămâne pe server, neschimbată: amprenta e doar un strat în plus pe telefon.

## O singură dată

1. **Pe telefon:** Setări → Despre telefon → apasă de 7 ori pe *Număr versiune* → apare *Opțiuni dezvoltator* → activează **Depanare USB**.
2. **Vocea română:** Setări → Sistem → Limbă → *Ieșire text-to-speech* → motorul Google, limba română (descarcă vocea dacă cere).
3. **adb în PATH** (vine cu Android Studio). În PowerShell, pentru sesiunea curentă:
   ```powershell
   $env:Path += ";$env:LOCALAPPDATA\Android\Sdk\platform-tools"
   ```

## 1. Pornește serverul pe laptop

```bash
npm.cmd run dev
```

(În PowerShell scrie `npm.cmd`, nu `npm`: execuția scripturilor `.ps1` e blocată pe acest PC.)

## 2. Construiește APK-ul

```bash
npm.cmd run android:apk
```

Face build-ul web, îl copiază în proiectul Android (`npx cap sync android`) și generează
`apps/web/android/app/build/outputs/apk/debug/app-debug.apk`. Prima dată durează câteva minute (Gradle descarcă dependențele).

> Avast verifică HTTPS cu certificatul lui; scriptul îi spune lui Gradle să folosească certificatele din Windows
> (`-Djavax.net.ssl.trustStoreType=Windows-ROOT`, și în `android/gradle.properties`). Fără asta, descărcările pică cu „PKIX path building failed”.

## 3. Instalează pe telefon

**Varianta A — cablu USB (cea mai sigură):**
```bash
adb devices
```
```bash
npm.cmd run android:install
```
```bash
adb reverse tcp:3001 tcp:3001
```
Cu `adb reverse`, telefonul vede serverul laptopului la `localhost:3001` — adresa implicită a aplicației. Nu trebuie setat nimic.

**Varianta B — fără cablu:** copiază `app-debug.apk` pe telefon (Drive, e-mail, Bluetooth), deschide-l și permite „Instalare din surse necunoscute”.
Apoi în aplicație: **Setări → Adresa serverului** → `192.168.1.104:3001` (IP-ul laptopului în Wi-Fi; verifică-l cu `ipconfig`) → *Salvează și testează*.
Telefonul și laptopul trebuie să fie în aceeași rețea Wi-Fi. Dacă nu se conectează, permite Node.js în Windows Firewall (rețea privată).

**Varianta C — fără cablu, prin internet (recomandată la demo):** merge pe orice Wi-Fi sau pe date mobile, fără setări de firewall.
Pe rețeaua „PagoGuest” varianta B nu merge: Windows o consideră rețea publică, firewall-ul blochează Node.js, iar rețelele pentru oaspeți de obicei nu lasă dispozitivele să se vadă între ele.
```bash
npm.cmd run tunnel:api
```
În terminal apare o adresă `https://<ceva>.trycloudflare.com`. În aplicație: **Setări → Adresa serverului** → lipește adresa → *Salvează și testează*.
Adresa se schimbă la fiecare pornire a tunelului, deci o reintroduci în aplicație de fiecare dată. Cât rulează tunelul, oricine are adresa poate folosi serverul demo (date fictive, dar consumă din limita Groq) — oprește-l după demo (Ctrl+C).

## 4. Prima pornire

- Android cere voie pentru **microfon** la prima apăsare pe sfera Pago AI → *Permite*.
- La **Confirmă plata** apare amprenta / Face Unlock. Dacă telefonul nu are amprentă sau blocare de ecran, plata continuă fără ea.
- „Da” rostit confirmă în continuare plățile sub 500 de lei (fără amprentă); peste 500 de lei, doar butonul.

## După o modificare în cod

```bash
npm.cmd run android:apk
```
```bash
npm.cmd run android:install
```

## Probleme

| Simptom | Rezolvare |
|---|---|
| „Nu pot ajunge la server” | Serverul pornit? Cu cablu: `adb reverse tcp:3001 tcp:3001` (se pierde la deconectare). Fără cablu: IP-ul corect în Setări, aceeași rețea, firewall. |
| Microfonul nu pornește | Setări telefon → Aplicații → Pago AI → Permisiuni → Microfon. Aplicația Google trebuie să fie activă (ea face recunoașterea). |
| Vocea are accent străin | Instalează vocea română în Google Text-to-Speech (pasul 2 de mai sus). |
| `adb` nu e găsit | Pasul 3 din „O singură dată”. |
| `JAVA_HOME` lipsă la build | `$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'` |
