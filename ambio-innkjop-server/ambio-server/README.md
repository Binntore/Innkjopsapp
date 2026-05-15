# Ambio Innkjøp og varer

IT-innkjøp og lagerstyring med PowerOffice Go-integrasjon.

---

## Kom i gang

### Forutsetninger

Du trenger **Node.js** installert på maskinen.
Last ned gratis fra: https://nodejs.org (velg **LTS**-versjonen)

Sjekk om det allerede er installert ved å åpne Terminal / PowerShell og skrive:
```
node --version
```
Hvis du ser et versjonsnummer (f.eks. `v20.x.x`) er du klar.

---

### Windows — enkleste måte

1. Pakk ut mappen `ambio-innkjop-server` et sted på PCen (f.eks. `C:\TEst\ambio`)
2. Dobbeltklikk på **`start.bat`**
3. Et terminalvindu åpnes og installerer alt automatisk
4. Åpne nettleseren og gå til **http://localhost:3000**

---

### Mac / Linux

1. Pakk ut mappen
2. Åpne Terminal i mappen
3. Kjør:
```bash
chmod +x start.sh
./start.sh
```
4. Åpne nettleseren og gå til **http://localhost:3000**

---

### Manuell måte (alle plattformer)

Åpne Terminal / PowerShell **i denne mappen** og kjør:

```bash
# Steg 1: Installer avhengigheter (kun første gang)
npm install

# Steg 2: Start serveren
node server.js
```

Åpne nettleseren og gå til **http://localhost:3000**

---

## Filstruktur

```
ambio-innkjop-server/
├── server.js          ← Express-server + PowerOffice Go-proxy
├── package.json       ← Node-avhengigheter
├── start.bat          ← Dobbeltklikk for å starte (Windows)
├── start.sh           ← Kjør for å starte (Mac/Linux)
├── README.md          ← Denne filen
└── public/
    └── index.html     ← Frontend-appen
```

---

## PowerOffice Go — Ambio AS

Serveren bruker følgende forhåndskonfigurerte API-nøkler for **Ambio AS**:

| Nøkkel | Verdi |
|--------|-------|
| Miljø | Demo (testmiljø) |
| Client ID | c0be4bb8-3960-40ba-97cc-4c32ef03977c |
| Application Key | a44b5774-ec58-425d-ae85-e268701b9720 |
| Client Key | 14873219-fa02-746b-23de-3a383de36115 |
| Subscription Key (primær) | 2abbd71d945a41d2b100e4505324d730 |

For å bytte til **produksjonsmiljø**, åpne `server.js` og endre:
```js
useDemo: false,
```

---

## API-endepunkter (server)

| Endepunkt | Beskrivelse |
|-----------|-------------|
| `GET /api/status` | Sjekk tilkobling til PowerOffice Go |
| `GET /api/pogo/Suppliers` | Hent leverandører |
| `POST /api/pogo/Vouchers` | Opprett bestilling/voucher |
| `GET /api/pogo/*` | Alle andre PowerOffice Go v2-endepunkter |

---

## Feilsøking

**"Cannot find package 'express'"**
→ Du glemte å kjøre `npm install`. Kjør det først.

**Appen viser "er serveren startet?"**
→ Sørg for at `node server.js` kjører i et terminalvindu.

**Siden laster ikke på http://localhost:3000**
→ Sjekk at ingen annen app bruker port 3000. Du kan endre port i `server.js`:
```js
const PORT = process.env.PORT || 3001;  // bytt til f.eks. 3001
```
