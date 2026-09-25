# Datenschutz / Privacy

**Deutsch**

- Broetry Blocker läuft nur auf `linkedin.com`.
- Zur Erkennung schickt die Extension den **Text** von Feed-Posts an unser Backend. Das Backend reicht ihn an TypeSafe AI (Modell Jev) weiter. Namen, Profile, Bilder, Kommentare und Cookies werden nicht übertragen.
- Es gibt keinen Account. Die Extension speichert eine zufällige, anonyme Install-ID, um Tageslimits durchzusetzen.
- Das Backend speichert keine Post-Texte. Im Arbeitsspeicher liegen nur ein Hash des Texts mit dem Ergebnis (Cache) sowie Tageszähler pro Install-ID und IP-Adresse (Rate-Limits). Beides verschwindet bei einem Neustart, die Zähler zusätzlich täglich.
- Einstellungen, Statistiken und der Ergebnis-Cache liegen lokal im Browser (`storage.local`).

**English**

- Broetry Blocker only runs on `linkedin.com`.
- To classify posts, the extension sends the **text** of feed posts to our backend, which forwards it to TypeSafe AI (Jev model). Names, profiles, images, comments and cookies are never sent.
- There is no account. The extension stores a random anonymous install ID used to enforce daily limits.
- The backend does not store post texts. It keeps only an in-memory text hash with its result (cache) and daily counters per install ID and IP address (rate limits); both are cleared on restart, and counters reset daily.
- Settings, stats and the result cache are stored locally in the browser (`storage.local`).
