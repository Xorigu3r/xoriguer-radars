# Xoriguer Radars

App Android (i PWA) que avisa per veu en català, xiulet/notificació i vibració dels **radars fixos i trams de velocitat mitjana** que tens **al davant**: primer avís a 1 km (configurable) i segon a 200 m.

- **APK Android:** avisa també **amb la pantalla apagada** (servei de GPS amb notificació fixa).
- **PWA:** la mateixa web, però només amb la pantalla encesa i l'app al davant.

## Instal·lar l'APK
1. Copia `Xoriguer.apk` al mòbil (cable, Drive, correu…) i obre'l. Android demanarà permís per instal·lar apps d'aquesta font.
2. Obre Radars i toca **Engega**: dona permís d'**ubicació** i de **notificacions**.
3. Ajustos del mòbil → Aplicacions → Radars → Bateria → **Sense restriccions** (si no, Android el pot aturar amb la pantalla apagada).
4. Ajustos de l'app → **Demo** per sentir com avisa sense moure't de casa.

## Compilar
```
npm install
npm run apk          # copia la web, cap sync i gradlew assembleDebug → Xoriguer.apk
```
Fa servir el JDK 21 i l'SDK de `~/android-tools` (veure `scripts/build-apk.ps1`).

## Altres ordres
```
npm run radars       # regenera www/radars.json (DGT + OSM)
npm run icons        # regenera icones i pantalla d'inici des de www/icons/logo.svg
npx capacitor-assets generate --android   # passa les icones a l'app Android
npm test             # proves de la lògica
npm run serve        # prova la web a http://localhost:8080
```

## Limitacions
- La DGT no diu en quin sentit mira el radar: en autovia pot avisar del del carril contrari. Els d'OSM sí que solen tenir sentit i es filtren.
- Catalunya i País Basc surten d'OpenStreetMap (no oficial).
- No inclou radars mòbils ni la majoria d'urbans.
- L'APK porta els radars del dia que es va compilar; per actualitzar-los cal recompilar-lo (`npm run radars` + `npm run apk`).
