# Xoriguer Radars

App Android (i PWA) que avisa per veu en català, xiulet i vibració dels **radars fixos i trams de velocitat mitjana** que tens **al davant**: primer avís a 1 km (configurable) i segon a 200 m.

- **APK Android:** avisa també **amb la pantalla apagada** (servei de GPS amb notificació fixa), i pel **Bluetooth del cotxe com una trucada** (talla la ràdio).
- **PWA:** la mateixa web, però només amb la pantalla encesa i l'app al davant.

## Què inclou
- **Radars oficials:** DGT (Espanya), Servei Català de Trànsit (Catalunya, amb límits) i França. Portugal, Andorra, Itàlia i País Basc, d'OpenStreetMap.
- **Mode legal per país:** a França només avisa de «zona de control» (la llei no permet dir on és el radar). A Alemanya i Suïssa no hi ha avisos (és il·legal).
- **Velocitat mitjana als trams**, amb avís si te'n passes.
- **Incidències de trànsit** de la DGT i el SCT (accidents, retencions, talls; les obres, opcionals). Només a l'APK.
- **Mapa** opcional que gira amb el cotxe, amb els radars i les incidències.
- **Mapa sense connexió:** paquets per comunitats i països (es generen cada mes a GitHub), zona al voltant d'on ets, o el mapa d'una ruta.
- **Avís de versió nova** dins l'app.

## Instal·lar l'APK
1. Descarrega `XoriguerRadars.apk` de les [Releases](https://github.com/Xorigu3r/xoriguer-radars/releases) i obre'l al mòbil. Android demanarà permís per instal·lar apps d'aquesta font.
2. Obre Radars i toca **Engega**: dona permís d'**ubicació** i de **notificacions**.
3. Ajustos del mòbil → Aplicacions → Radars → Bateria → **Sense restriccions** (si no, Android el pot aturar amb la pantalla apagada).
4. Ajustos de l'app → **Prova el so** (amb el Bluetooth del cotxe) i **Demo**.

## Compilar
```
npm install
npm run apk          # copia la web i les llibreries, cap sync i gradlew assembleDebug → Xoriguer.apk
```
Fa servir el JDK 21 i l'SDK de `~/android-tools` (veure `scripts/build-apk.ps1`).

## Altres ordres
```
npm run radars       # regenera www/radars.json (DGT, SCT, França, OSM i límits)
npm run icons        # regenera icones i pantalla d'inici des de www/icons/logo.svg
npm test             # proves de la lògica
npm run serve        # prova la web a http://localhost:8080
```
Paquets de mapa: workflow **Paquets de mapa** (`.github/workflows/mapes.yml`), cada mes o a mà.

## Limitacions
- La DGT i el SCT no diuen en quin sentit mira el radar: en autovia pot avisar del del carril contrari. Els d'OSM sí que solen tenir sentit i es filtren.
- Els radars d'OpenStreetMap no són oficials.
- No inclou radars mòbils.
- Això no és assessorament legal: comprova les normes de cada país.
