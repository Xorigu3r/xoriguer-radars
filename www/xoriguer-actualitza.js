// Xoriguer · actualitzacions sense reinstal·lar (app d'Android). Còpia idèntica a cada app: l'original és
// XoriguerAPKs/plantilla/xoriguer-actualitza.js. Fa servir el connector natiu XoriguerActualitza.
//
// A https://xoriguer.dev/versions/<app>/versio.json:
//   web, web_zip, web_sha256, web_mida  -> la darrera versió de la part web (la VERSIO del JS de l'app)
//   apk_min                             -> versionCode mínim de l'APK que la pot fer servir
//   apk, apk_codi, versio               -> la darrera APK (per quan cal reinstal·lar)
//
// Ús a l'app:
//   XActualitza.inicia({ app: 'pdf', versio: VERSIO });       // a l'arrencada (confirma que la versió funciona)
//   if (await XActualitza.comprova(manual)) return;            // a «Busca actualitzacions»; false = no és l'app d'Android
(function () {
  'use strict';
  const C = window.Capacitor;
  const natiu = !!(C && C.isNativePlatform && C.isNativePlatform() && C.getPlatform && C.getPlatform() === 'android');
  // el connector natiu: amb @capacitor/core (registerPlugin) o el que exporta l'app d'Android a Capacitor.Plugins
  const P = !natiu ? null : (C.Plugins && C.Plugins.XoriguerActualitza) || (C.registerPlugin ? C.registerPlugin('XoriguerActualitza') : null);
  let APP = '', VERSIO = '0', iniciat = null;

  const TXT = {
    ca: {
      buscant: 'Buscant actualitzacions…', darrera: 'Ja tens la darrera versió ({v}).', error: "No s'ha pogut comprovar. Tens connexió a Internet?",
      titolWeb: 'Hi ha una actualització', web: 'Hi ha la versió {v} (tu tens la {a}). S\'aplica en uns segons, sense reinstal·lar res i sense perdre res.',
      actualitza: 'Actualitza ara', tard: 'Més tard', baixant: 'Baixant… {p}', aplicant: 'Aplicant…', errBaixa: "No s'ha pogut baixar l'actualització. Torna-ho a provar més tard.",
      titolApk: 'Cal instal·lar la versió nova', apk: "La versió {v} canvia parts de l'app que només es poden posar reinstal·lant-la. Baixa-la i instal·la-la per sobre: no es perd res.",
      baixaApk: "Baixa l'app", fet: 'Actualitzat a la versió {v}.', d: 'Tancar', boto: 'Busca actualitzacions',
    },
    es: {
      buscant: 'Buscando actualizaciones…', darrera: 'Ya tienes la última versión ({v}).', error: 'No se ha podido comprobar. ¿Tienes conexión a Internet?',
      titolWeb: 'Hay una actualización', web: 'Hay la versión {v} (tú tienes la {a}). Se aplica en unos segundos, sin reinstalar nada y sin perder nada.',
      actualitza: 'Actualizar ahora', tard: 'Más tarde', baixant: 'Descargando… {p}', aplicant: 'Aplicando…', errBaixa: 'No se ha podido descargar la actualización. Vuelve a probarlo más tarde.',
      titolApk: 'Hay que instalar la versión nueva', apk: 'La versión {v} cambia partes de la app que solo se pueden poner reinstalándola. Descárgala e instálala encima: no se pierde nada.',
      baixaApk: 'Descargar la app', fet: 'Actualizado a la versión {v}.', d: 'Cerrar', boto: 'Buscar actualizaciones',
    },
    fr: {
      buscant: 'Recherche de mises à jour…', darrera: 'Vous avez déjà la dernière version ({v}).', error: "Impossible de vérifier. Êtes-vous connecté à Internet ?",
      titolWeb: 'Une mise à jour est disponible', web: "La version {v} est disponible (vous avez la {a}). Elle s'applique en quelques secondes, sans rien réinstaller ni rien perdre.",
      actualitza: 'Mettre à jour', tard: 'Plus tard', baixant: 'Téléchargement… {p}', aplicant: 'Application…', errBaixa: 'Impossible de télécharger la mise à jour. Réessayez plus tard.',
      titolApk: 'Il faut installer la nouvelle version', apk: "La version {v} modifie des parties de l'app qui ne peuvent changer qu'en la réinstallant. Téléchargez-la et installez-la par-dessus : rien n'est perdu.",
      baixaApk: "Télécharger l'app", fet: 'Mis à jour vers la version {v}.', d: 'Fermer', boto: 'Rechercher des mises à jour',
    },
    en: {
      buscant: 'Checking for updates…', darrera: 'You already have the latest version ({v}).', error: "Couldn't check. Are you connected to the Internet?",
      titolWeb: 'An update is available', web: 'Version {v} is available (you have {a}). It installs in a few seconds, without reinstalling anything or losing anything.',
      actualitza: 'Update now', tard: 'Later', baixant: 'Downloading… {p}', aplicant: 'Applying…', errBaixa: "Couldn't download the update. Please try again later.",
      titolApk: 'The new version must be installed', apk: 'Version {v} changes parts of the app that can only be updated by reinstalling it. Download it and install it over the current one: nothing is lost.',
      baixaApk: 'Download the app', fet: 'Updated to version {v}.', d: 'Close', boto: 'Check for updates',
    },
  };
  function t(k, o) {
    const l = (document.documentElement.lang || 'ca').slice(0, 2).toLowerCase();
    let s = (TXT[l] || TXT.ca)[k] || TXT.ca[k];
    for (const x in o || {}) s = s.replace('{' + x + '}', o[x]);
    return s;
  }
  const mesNova = (a, b) => {
    const pa = String(a).replace(/^v/i, '').split(/[.\s-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split(/[.\s-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('xact.' + APP + '.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('xact.' + APP + '.' + k, JSON.stringify(v)); } catch { /* res */ } },
  };
  const mb = (b) => (b / 1048576).toFixed(1).replace('.', ',') + ' MB';

  // ---------- diàleg propi (Blau pissarra; no depèn de l'app) ----------
  function estil() {
    if (document.getElementById('xact-estil')) return;
    const s = document.createElement('style');
    s.id = 'xact-estil';
    s.textContent = `
.xact-fons{position:fixed;inset:0;z-index:2147483000;background:rgba(15,22,32,.6);display:grid;place-items:center;padding:16px;font:16px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.xact-c{background:#27354A;color:#F6EFE2;border:1px solid #41506A;border-radius:18px;max-width:420px;width:100%;padding:20px 20px 16px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.xact-c h2{margin:0 0 8px;font-size:19px}
.xact-c p{margin:0 0 14px;color:#B9B2A5}
.xact-b{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.xact-b button{font:inherit;border:0;border-radius:12px;padding:11px 18px;cursor:pointer;background:#31405A;color:#F6EFE2}
.xact-b button.p{background:linear-gradient(135deg,#FFA82E,#F2650F);color:#1E2A3B;font-weight:700}
.xact-barra{height:8px;border-radius:8px;background:#31405A;overflow:hidden;margin:0 0 14px}
.xact-c [hidden]{display:none!important}
.xact-barra i{display:block;height:100%;width:0;background:linear-gradient(90deg,#FFA82E,#F2650F);transition:width .2s}`;
    document.head.appendChild(s);
  }
  function dialeg(titol, text, botons) {
    estil();
    return new Promise((ok) => {
      const f = document.createElement('div');
      f.className = 'xact-fons';
      f.innerHTML = '<div class="xact-c" role="dialog" aria-modal="true"><h2></h2><p></p><div class="xact-barra" hidden><i></i></div><div class="xact-b"></div></div>';
      f.querySelector('h2').textContent = titol;
      f.querySelector('p').textContent = text;
      const tanca = (v) => { f.remove(); ok(v); };
      for (const b of botons) {
        const e = document.createElement('button');
        e.type = 'button';
        e.textContent = b.text;
        if (b.primari) e.className = 'p';
        e.onclick = () => (b.fes ? b.fes(f, tanca) : tanca(b.valor));
        f.querySelector('.xact-b').appendChild(e);
      }
      document.body.appendChild(f);
    });
  }

  async function llegeixVersio() {
    const r = await fetch(`https://xoriguer.dev/versions/${APP}/versio.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function actualitzaWeb(j) {
    return dialeg(t('titolWeb'), t('web', { v: j.web, a: VERSIO }) + (j.web_mida ? ` (${mb(j.web_mida)})` : ''), [
      { text: t('tard'), valor: 'tard' },
      {
        text: t('actualitza'), primari: true,
        fes: async (f, tanca) => {
          const p = f.querySelector('p'), barra = f.querySelector('.xact-barra'), b = f.querySelector('.xact-b');
          b.hidden = true; barra.hidden = false;
          p.textContent = t('baixant', { p: '' });
          const esc = P.addListener('progres', (e) => {
            const tot = e.total > 0 ? e.total : j.web_mida || 0;
            p.textContent = t('baixant', { p: tot ? Math.round((e.bytes / tot) * 100) + ' %' : mb(e.bytes) });
            if (tot) barra.firstChild.style.width = Math.min(100, (e.bytes / tot) * 100) + '%';
          });
          try {
            const { cami } = await P.baixa({ url: j.web_zip, sha256: j.web_sha256 || '', versio: j.web });
            p.textContent = t('aplicant');
            barra.firstChild.style.width = '100%';
            ls.set('acabaDActualitzar', j.web);
            await P.aplica({ cami, versio: j.web });   // la pàgina es torna a carregar sola
          } catch (e) {
            try { const h = await esc; if (h && h.remove) h.remove(); } catch { /* res */ }
            p.textContent = t('errBaixa');
            barra.hidden = true; b.hidden = false;
            b.innerHTML = '';
            const x = document.createElement('button');
            x.type = 'button'; x.textContent = t('d'); x.onclick = () => tanca('error');
            b.appendChild(x);
          }
        },
      },
    ]);
  }

  async function demanaApk(j) {
    const v = await dialeg(t('titolApk'), t('apk', { v: j.versio || '' }), [
      { text: t('tard'), valor: 'tard' },
      { text: t('baixaApk'), valor: 'ok', primari: true },
    ]);
    if (v === 'ok') P.obre({ url: j.apk }).catch(() => window.open(j.apk, '_blank'));
    return v;
  }

  /** true si ho ha gestionat (app d'Android amb el connector); false perquè l'app faci el seu (web, escriptori). */
  async function comprova(manual, avisa) {
    if (!P) return false;
    await iniciat;
    // on surt el resultat: on diu l'app o, si no en té, en un diàleg (només si l'ha demanat la persona)
    const diu = (s) => { if (avisa) avisa(s); else if (manual && s && s !== t('buscant')) dialeg(s, '', [{ text: 'OK', primari: true, valor: 'ok' }]); };
    if (!manual && Date.now() - ls.get('ultima', 0) < 20 * 3600e3) return true;
    ls.set('ultima', Date.now());
    diu(t('buscant'));
    let info, j;
    try {
      info = await P.info();
      j = await llegeixVersio();
    } catch {
      diu(t('error'));
      return true;
    }
    const webNova = j.web && j.web_zip && mesNova(j.web, VERSIO) && (info.apkCodi || 0) >= (j.apk_min || 0) && j.web !== info.fallida;
    const apkNova = j.apk && j.apk_codi && j.apk_codi > (info.apkCodi || 0);
    if (webNova) {
      if (!manual && ls.get('tancada', '') === 'w' + j.web) return true;
      diu('');
      const v = await actualitzaWeb(j);
      if (v === 'tard') ls.set('tancada', 'w' + j.web);
    } else if (apkNova && (j.apk_min || 0) > (info.apkCodi || 0)) {
      // la part web nova necessita una APK nova
      if (!manual && ls.get('tancada', '') === 'a' + j.apk_codi) return true;
      diu('');
      if ((await demanaApk(j)) === 'tard') ls.set('tancada', 'a' + j.apk_codi);
    } else if (apkNova && manual) {
      diu('');
      await demanaApk(j);
    } else {
      diu(t('darrera', { v: VERSIO }));
    }
    return true;
  }

  async function inicia(o) {
    APP = o.app;
    VERSIO = String(o.versio);
    if (!P) return;
    iniciat = (async () => {
      try {
        await P.confirma();                       // aquesta versió arrenca bé
        // a l'app no hi ha d'haver service worker (serviria fitxers vells)
        if (navigator.serviceWorker) {
          const rs = await navigator.serviceWorker.getRegistrations();
          for (const r of rs) await r.unregister();
        }
      } catch { /* res */ }
      const fet = ls.get('acabaDActualitzar', '');
      if (fet) {
        ls.set('acabaDActualitzar', '');
        if (fet === VERSIO) dialeg(t('fet', { v: VERSIO }), '', [{ text: 'OK', primari: true, valor: 'ok' }]);
      }
    })();
    setTimeout(() => comprova(false), 5000);
  }

  window.XActualitza = { inicia, comprova, text: t, natiu: !!P };
})();
