package cat.xoriguer.radars;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;

/**
 * Veu dels avisos amb control de per on surt el so.
 *
 * El connector text-to-speech no posa AudioAttributes: el so surt com a "multimèdia" i, amb el
 * Bluetooth del cotxe connectat, Android l'envia al cotxe i silencia el mòbil. Si el cotxe no
 * és a la font Bluetooth (ràdio, USB…), no se sent enlloc.
 *
 * Sortides:
 *  - "trucada":    Bluetooth com una trucada (HFP/SCO). El cotxe talla la ràdio, com fa Google Maps.
 *  - "altaveu":    canal d'alarma: sona per l'altaveu del mòbil encara que hi hagi Bluetooth.
 *  - "multimedia": com la música, però demanant el focus d'àudio (abaixa la música que soni).
 *  - "auto":       "trucada" si hi ha un dispositiu Bluetooth de veu connectat; si no, "altaveu".
 */
@CapacitorPlugin(name = "VeuRadar")
public class VeuRadarPlugin extends Plugin {

    private static final int SCO_TIMEOUT_MS = 3500;

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String idioma = "";
    private AudioManager am;
    private final Handler main = new Handler(Looper.getMainLooper());

    private String rutaActiva = null;        // ruta de l'avís en curs
    private Object focusRequest = null;      // AudioFocusRequest (API 26+)
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> { };
    private BroadcastReceiver scoReceiver = null;
    private int generacio = 0;               // per descartar callbacks d'avisos antics

    @Override
    public void load() {
        am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        tts = new TextToSpeech(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS) return;
            Locale ca = new Locale("ca", "ES");
            if (tts.isLanguageAvailable(ca) >= TextToSpeech.LANG_AVAILABLE) {
                tts.setLanguage(ca);
                idioma = "ca";
            } else {
                tts.setLanguage(new Locale("es", "ES"));
                idioma = "es";
            }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { finalitza(id); }
                @Override public void onError(String id) { finalitza(id); }
            });
            ttsReady = true;
        });
    }

    @Override
    protected void handleOnDestroy() {
        allibera();
        if (tts != null) tts.shutdown();
    }

    /** Estat per als ajustos: si la veu és a punt, en quin idioma, i si hi ha Bluetooth de veu. */
    @PluginMethod
    public void estat(PluginCall call) {
        JSObject r = new JSObject();
        r.put("preparat", ttsReady);
        r.put("idioma", idioma);
        r.put("bluetooth", hiHaBluetoothVeu());
        call.resolve(r);
    }

    /** avisa({ text, sortida, xiulets, vibra }) */
    @PluginMethod
    public void avisa(PluginCall call) {
        if (!ttsReady) { call.reject("La veu encara no és a punt"); return; }
        final String text = call.getString("text", "");
        String sortida = call.getString("sortida", "auto");
        final int xiulets = Math.max(0, Math.min(4, call.getInt("xiulets", 0)));
        final boolean vibra = Boolean.TRUE.equals(call.getBoolean("vibra", false));

        if ("auto".equals(sortida)) sortida = hiHaBluetoothVeu() ? "trucada" : "altaveu";
        final String ruta = sortida;

        main.post(() -> {
            // Un avís nou talla l'anterior.
            tts.stop();
            allibera();
            final int gen = ++generacio;
            rutaActiva = ruta;
            if (vibra) vibra(xiulets >= 3);
            demanaFocus(ruta);

            Runnable parla = () -> {
                if (gen != generacio) return;
                int espera = fesXiulets(ruta, xiulets);
                main.postDelayed(() -> { if (gen == generacio) parla(text, ruta, gen); }, espera);
            };
            if ("trucada".equals(ruta)) obreSco(gen, parla);
            else parla.run();

            JSObject r = new JSObject();
            r.put("sortida", ruta);
            r.put("idioma", idioma);
            call.resolve(r);
        });
    }

    // ---------------------------------------------------------------- àudio

    private AudioAttributes atributs(String ruta) {
        int usage;
        switch (ruta) {
            case "trucada": usage = AudioAttributes.USAGE_VOICE_COMMUNICATION; break;
            case "altaveu": usage = AudioAttributes.USAGE_ALARM; break;
            default: usage = AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE;
        }
        return new AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
    }

    private int stream(String ruta) {
        switch (ruta) {
            case "trucada": return AudioManager.STREAM_VOICE_CALL;
            case "altaveu": return AudioManager.STREAM_ALARM;
            default: return AudioManager.STREAM_MUSIC;
        }
    }

    private void parla(String text, String ruta, int gen) {
        tts.setAudioAttributes(atributs(ruta));
        Bundle p = new Bundle();
        p.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, stream(ruta)); // per a motors antics
        p.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, p, "avis-" + gen);
        if (res != TextToSpeech.SUCCESS) finalitza("avis-" + gen);
    }

    /** Fa sonar els xiulets pel mateix camí que la veu. Retorna quant cal esperar abans de parlar. */
    private int fesXiulets(String ruta, int n) {
        if (n <= 0) return 0;
        try {
            final ToneGenerator tg = new ToneGenerator(stream(ruta), 90);
            for (int i = 0; i < n; i++) {
                main.postDelayed(() -> tg.startTone(ToneGenerator.TONE_PROP_BEEP, 160), i * 260L);
            }
            main.postDelayed(tg::release, n * 260L + 400);
        } catch (RuntimeException e) {
            return 0; // si el ToneGenerator falla, parlem igualment
        }
        return n * 260 + 200;
    }

    private void demanaFocus(String ruta) {
        if (Build.VERSION.SDK_INT >= 26) {
            AudioFocusRequest req = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(atributs(ruta))
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
            am.requestAudioFocus(req);
            focusRequest = req;
        } else {
            am.requestAudioFocus(focusListener, stream(ruta), AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    private void deixaFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest != null) am.abandonAudioFocusRequest((AudioFocusRequest) focusRequest);
            focusRequest = null;
        } else {
            am.abandonAudioFocus(focusListener);
        }
    }

    // ---------------------------------------------------------------- Bluetooth com a trucada

    private boolean hiHaBluetoothVeu() {
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return true;
            }
            return false;
        }
        if (!am.isBluetoothScoAvailableOffCall()) return false;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return true;
        }
        return false;
    }

    /** Obre l'enllaç de veu Bluetooth (com una trucada) i crida `despres` quan és a punt o en esgotar el temps. */
    private void obreSco(int gen, Runnable despres) {
        final boolean[] fet = { false };
        final Runnable unCop = () -> {
            if (fet[0] || gen != generacio) return;
            fet[0] = true;
            despres.run();
        };
        try {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo sco = null;
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) { sco = d; break; }
                }
                if (sco == null || !am.setCommunicationDevice(sco)) { unCop.run(); return; }
                // Esperem que l'enllaç estigui obert (sol trigar 0,5–2 s).
                final long inici = System.currentTimeMillis();
                Runnable comprova = new Runnable() {
                    @Override public void run() {
                        if (fet[0] || gen != generacio) return;
                        AudioDeviceInfo actual = am.getCommunicationDevice();
                        boolean llest = actual != null && actual.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO;
                        if (llest) main.postDelayed(unCop, 600);   // marge perquè el cotxe obri l'àudio
                        else if (System.currentTimeMillis() - inici > SCO_TIMEOUT_MS) unCop.run();
                        else main.postDelayed(this, 200);
                    }
                };
                main.postDelayed(comprova, 200);
            } else {
                scoReceiver = new BroadcastReceiver() {
                    @Override public void onReceive(Context c, Intent i) {
                        int st = i.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1);
                        if (st == AudioManager.SCO_AUDIO_STATE_CONNECTED) main.postDelayed(unCop, 600);
                    }
                };
                getContext().registerReceiver(scoReceiver, new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED));
                am.startBluetoothSco();
                am.setBluetoothScoOn(true);
                main.postDelayed(unCop, SCO_TIMEOUT_MS);
            }
        } catch (RuntimeException e) {
            unCop.run();
        }
    }

    private void tancaSco() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice();
            } else {
                if (scoReceiver != null) {
                    try { getContext().unregisterReceiver(scoReceiver); } catch (IllegalArgumentException ignored) { }
                    scoReceiver = null;
                }
                am.setBluetoothScoOn(false);
                am.stopBluetoothSco();
            }
            am.setMode(AudioManager.MODE_NORMAL);
        } catch (RuntimeException ignored) { }
    }

    // ---------------------------------------------------------------- final

    private void finalitza(String id) {
        // Petit marge perquè no es talli l'última síl·laba en tancar l'enllaç Bluetooth.
        main.postDelayed(() -> {
            if (id != null && !id.equals("avis-" + generacio)) return;
            allibera();
        }, 500);
    }

    private void allibera() {
        if (rutaActiva == null) return;
        if ("trucada".equals(rutaActiva)) tancaSco();
        deixaFocus();
        rutaActiva = null;
    }

    private void vibra(boolean fort) {
        Vibrator v = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        long[] patro = fort ? new long[] { 0, 300, 120, 300, 120, 300 } : new long[] { 0, 250, 120, 250 };
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(patro, -1));
        else v.vibrate(patro, -1);
    }
}
