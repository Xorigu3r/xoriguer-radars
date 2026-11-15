package cat.xoriguer.radars;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Updates the app's web part (HTML/JS/CSS) without reinstalling the APK.
 *
 * Capacitor can serve the page from a folder on the phone instead of the one inside the APK
 * (setServerBasePath, saved in CapWebViewSettings). This plugin downloads web-<version>.zip from
 * xoriguer.dev, checks its sha256, builds a full copy (the APK's files + the zip on top) in
 * files/web/<version>/ and switches to it. Same origin (https://localhost): the saved data stays.
 *
 * Safety: the new version must call confirma() once it has started. If it doesn't after 3 launches,
 * the app goes back to the version inside the APK. When a newer APK is installed, Capacitor itself
 * goes back to the APK's files (isNewBinary).
 */
@CapacitorPlugin(name = "XoriguerActualitza")
public class XoriguerActualitza extends Plugin {
    private static final String CAP_PREFS = "CapWebViewSettings";
    private static final String CAP_PATH = "serverBasePath";
    private static final int INTENTS_MAX = 3;

    private SharedPreferences prefs() { return getContext().getSharedPreferences("xoriguer_actualitza", Context.MODE_PRIVATE); }
    private SharedPreferences cap() { return getContext().getSharedPreferences(CAP_PREFS, Activity.MODE_PRIVATE); }
    private File arrel() { return new File(getContext().getFilesDir(), "web"); }

    @Override
    public void load() {
        // runs before Capacitor reads serverBasePath, so going back here takes effect on this launch
        SharedPreferences p = prefs();
        String provant = p.getString("provant", "");
        if (provant.isEmpty()) return;
        int intents = p.getInt("intents", 0) + 1;
        if (intents >= INTENTS_MAX) {
            cap().edit().putString(CAP_PATH, "").commit();
            p.edit().putString("provant", "").putInt("intents", 0).putString("fallida", provant).commit();
        } else {
            p.edit().putInt("intents", intents).commit();
        }
    }

    private long codiVersio() {
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("apkCodi", codiVersio());
        try {
            r.put("apkVersio", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (Exception e) { r.put("apkVersio", ""); }
        String cami = cap().getString(CAP_PATH, "");
        r.put("baixada", cami != null && !cami.isEmpty() && new File(cami).exists());
        r.put("fallida", prefs().getString("fallida", ""));
        call.resolve(r);
    }

    /** The running version works: stop counting launches. */
    @PluginMethod
    public void confirma(PluginCall call) {
        prefs().edit().putString("provant", "").putInt("intents", 0).apply();
        call.resolve();
    }

    @PluginMethod
    public void baixa(PluginCall call) {
        String url = call.getString("url");
        String sha = call.getString("sha256", "");
        String versio = call.getString("versio", "");
        if (url == null || versio.isEmpty() || !versio.matches("[0-9A-Za-z._-]+")) {
            call.reject("dades incorrectes");
            return;
        }
        new Thread(() -> {
            File zip = new File(getContext().getCacheDir(), "web-" + versio + ".zip");
            File dest = new File(arrel(), versio);
            File tmp = new File(arrel(), versio + ".tmp");
            try {
                descarrega(url, zip);
                if (!sha.isEmpty() && !sha.equalsIgnoreCase(sha256(zip))) throw new Exception("sha256 no coincideix");
                esborra(tmp);
                tmp.mkdirs();
                copiaAssets(getContext().getAssets(), "public", tmp);   // the APK's files (cordova.js, etc.)
                descomprimeix(zip, tmp);                                 // the new version on top
                if (!new File(tmp, "index.html").exists()) throw new Exception("sense index.html");
                esborra(dest);
                if (!tmp.renameTo(dest)) throw new Exception("no es pot moure");
                // only the active version and this one are kept
                String actiu = cap().getString(CAP_PATH, "");
                File[] fs = arrel().listFiles();
                if (fs != null) for (File f : fs) {
                    if (!f.equals(dest) && !f.getAbsolutePath().equals(actiu)) esborra(f);
                }
                JSObject r = new JSObject();
                r.put("cami", dest.getAbsolutePath());
                call.resolve(r);
            } catch (Exception e) {
                esborra(tmp);
                call.reject(String.valueOf(e.getMessage()));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                zip.delete();
            }
        }).start();
    }

    @PluginMethod
    public void aplica(PluginCall call) {
        String cami = call.getString("cami", "");
        String versio = call.getString("versio", "");
        if (cami.isEmpty() || !new File(cami, "index.html").exists()) {
            call.reject("no hi ha la versió baixada");
            return;
        }
        cap().edit().putString(CAP_PATH, cami).commit();
        prefs().edit().putString("provant", versio).putInt("intents", 0).putString("fallida", "").commit();
        call.resolve();
        getActivity().runOnUiThread(() -> getBridge().setServerBasePath(cami));   // reloads the page
    }

    /** Back to the version inside the APK. */
    @PluginMethod
    public void restableix(PluginCall call) {
        cap().edit().putString(CAP_PATH, "").commit();
        prefs().edit().putString("provant", "").putInt("intents", 0).commit();
        call.resolve();
        getActivity().runOnUiThread(() -> getBridge().setServerAssetPath("public"));
    }

    /** Opens a link outside the app (the APK download goes to the browser, which then offers to install it). */
    @PluginMethod
    public void obre(PluginCall call) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url")));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // ---------- helpers ----------
    private void descarrega(String url, File out) throws Exception {
        URL u = new URL(url);
        for (int salts = 0; salts < 5; salts++) {
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(true);
            int codi = c.getResponseCode();
            if (codi >= 300 && codi < 400 && c.getHeaderField("Location") != null) {
                u = new URL(u, c.getHeaderField("Location"));
                continue;
            }
            if (codi != 200) throw new Exception("HTTP " + codi);
            long total = c.getContentLengthLong(), fet = 0, ultim = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream()); OutputStream o = new FileOutputStream(out)) {
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) {
                    o.write(b, 0, n);
                    fet += n;
                    if (fet - ultim > 200000) {
                        ultim = fet;
                        JSObject ev = new JSObject();
                        ev.put("bytes", fet);
                        ev.put("total", total);
                        notifyListeners("progres", ev);
                    }
                }
            }
            return;
        }
        throw new Exception("massa redireccions");
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) md.update(b, 0, n);
        }
        StringBuilder s = new StringBuilder();
        for (byte x : md.digest()) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static void descomprimeix(File zip, File dest) throws Exception {
        String base = dest.getCanonicalPath() + File.separator;
        try (ZipInputStream z = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry e;
            byte[] b = new byte[65536];
            while ((e = z.getNextEntry()) != null) {
                File f = new File(dest, e.getName());
                if (!f.getCanonicalPath().startsWith(base)) throw new Exception("camí no vàlid al zip");
                if (e.isDirectory()) { f.mkdirs(); continue; }
                File pare = f.getParentFile();
                if (pare != null) pare.mkdirs();
                try (OutputStream o = new FileOutputStream(f)) {
                    int n;
                    while ((n = z.read(b)) > 0) o.write(b, 0, n);
                }
            }
        }
    }

    private static void copiaAssets(AssetManager am, String cami, File dest) throws Exception {
        String[] fills = am.list(cami);
        if (fills == null || fills.length == 0) {
            InputStream in;
            try { in = am.open(cami); } catch (java.io.FileNotFoundException e) { dest.mkdirs(); return; }   // empty folder
            try (InputStream i2 = in; OutputStream o = new FileOutputStream(dest)) {
                byte[] b = new byte[65536];
                int n;
                while ((n = i2.read(b)) > 0) o.write(b, 0, n);
            }
            return;
        }
        dest.mkdirs();
        for (String f : fills) copiaAssets(am, cami + "/" + f, new File(dest, f));
    }

    private static void esborra(File f) {
        if (f == null || !f.exists()) return;
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) esborra(x);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
