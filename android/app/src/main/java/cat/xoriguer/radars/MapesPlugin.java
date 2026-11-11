package cat.xoriguer.radars;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Paquets de mapa (fitxers .pmtiles) desats al mòbil.
 *
 * El WebView no pot baixar-los directament de GitHub (les Releases no envien CORS) i el servidor
 * local de Capacitor no serveix bé trossos de fitxers grans. Per això:
 *  - descarrega({url, fitxer}): baixa el fitxer en natiu, amb progrés (event "progres") i es pot aturar.
 *  - llegeix({fitxer, offset, length}): retorna només els bytes demanats (base64), per a PMTiles.
 *  - llista(), esborra({fitxer}), espai()
 */
@CapacitorPlugin(name = "Mapes")
public class MapesPlugin extends Plugin {

    private final ExecutorService baixades = Executors.newFixedThreadPool(2);
    private final ExecutorService lectures = Executors.newFixedThreadPool(4);
    private final Map<String, Boolean> aturar = new ConcurrentHashMap<>();
    private final Map<String, RandomAccessFile> oberts = new HashMap<>();

    private File dir() {
        File d = new File(getContext().getFilesDir(), "mapes");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** Només noms senzills (sense camins) per no sortir de la carpeta. */
    private File fitxer(String nom) throws IOException {
        if (nom == null || !nom.matches("[A-Za-z0-9._-]+")) throw new IOException("Nom de fitxer no vàlid");
        return new File(dir(), nom);
    }

    @PluginMethod
    public void descarrega(PluginCall call) {
        final String url = call.getString("url");
        final String nom = call.getString("fitxer");
        if (url == null || !url.startsWith("https://")) { call.reject("Cal una adreça https"); return; }
        aturar.put(nom, false);
        baixades.execute(() -> {
            File part = null;
            try {
                File desti = fitxer(nom);
                part = new File(desti.getPath() + ".part");
                HttpURLConnection con = obre(url);
                long total = con.getContentLengthLong();
                long fet = 0, darrerAvis = 0;
                try (InputStream in = con.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (Boolean.TRUE.equals(aturar.get(nom))) throw new IOException("aturat");
                        out.write(buf, 0, n);
                        fet += n;
                        if (fet - darrerAvis > 2 * 1024 * 1024) {
                            darrerAvis = fet;
                            JSObject p = new JSObject();
                            p.put("fitxer", nom); p.put("bytes", fet); p.put("total", total);
                            notifyListeners("progres", p);
                        }
                    }
                } finally {
                    con.disconnect();
                }
                if (total > 0 && fet != total) throw new IOException("Descàrrega incompleta");
                tanca(nom);
                if (desti.exists()) desti.delete();
                if (!part.renameTo(desti)) throw new IOException("No s'ha pogut desar");
                JSObject r = new JSObject();
                r.put("fitxer", nom); r.put("bytes", fet);
                call.resolve(r);
            } catch (Exception e) {
                if (part != null) part.delete();
                call.reject("aturat".equals(e.getMessage()) ? "aturat" : ("Error de descàrrega: " + e.getMessage()));
            } finally {
                aturar.remove(nom);
            }
        });
    }

    /** Segueix redireccions (GitHub → servidor de fitxers) a mà, també entre dominis. */
    private HttpURLConnection obre(String url) throws IOException {
        for (int i = 0; i < 6; i++) {
            HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
            con.setInstanceFollowRedirects(false);
            con.setConnectTimeout(20000);
            con.setReadTimeout(60000);
            con.setRequestProperty("User-Agent", "XoriguerRadars");
            int code = con.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = con.getHeaderField("Location");
                con.disconnect();
                if (loc == null) throw new IOException("Redirecció sense destí");
                url = new URL(new URL(url), loc).toString();
                continue;
            }
            if (code != 200) { con.disconnect(); throw new IOException("HTTP " + code); }
            return con;
        }
        throw new IOException("Massa redireccions");
    }

    @PluginMethod
    public void atura(PluginCall call) {
        aturar.put(call.getString("fitxer", ""), true);
        call.resolve();
    }

    @PluginMethod
    public void llegeix(PluginCall call) {
        final String nom = call.getString("fitxer");
        final long offset = call.getLong("offset", 0L);
        final int length = call.getInt("length", 0);
        lectures.execute(() -> {
            try {
                byte[] buf = new byte[length];
                RandomAccessFile raf = obert(nom);
                int llegits;
                synchronized (raf) {
                    raf.seek(offset);
                    llegits = raf.read(buf, 0, length);
                }
                if (llegits < 0) llegits = 0;
                JSObject r = new JSObject();
                r.put("data", Base64.encodeToString(buf, 0, llegits, Base64.NO_WRAP));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Lectura: " + e.getMessage());
            }
        });
    }

    private synchronized RandomAccessFile obert(String nom) throws IOException {
        RandomAccessFile raf = oberts.get(nom);
        if (raf == null) {
            raf = new RandomAccessFile(fitxer(nom), "r");
            oberts.put(nom, raf);
        }
        return raf;
    }

    private synchronized void tanca(String nom) {
        RandomAccessFile raf = oberts.remove(nom);
        if (raf != null) try { raf.close(); } catch (IOException ignored) { }
    }

    @PluginMethod
    public void llista(PluginCall call) {
        JSArray arr = new JSArray();
        File[] fs = dir().listFiles();
        if (fs != null) for (File f : fs) {
            if (f.getName().endsWith(".part")) continue;
            JSObject o = new JSObject();
            o.put("fitxer", f.getName()); o.put("bytes", f.length());
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("fitxers", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void esborra(PluginCall call) {
        try {
            String nom = call.getString("fitxer");
            tanca(nom);
            File f = fitxer(nom);
            JSObject r = new JSObject();
            r.put("esborrat", !f.exists() || f.delete());
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void espai(PluginCall call) {
        JSObject r = new JSObject();
        r.put("lliure", dir().getUsableSpace());
        call.resolve(r);
    }
}
