package cat.xoriguer.radars;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Connectors propis; s'han de registrar abans de super.onCreate.
        registerPlugin(VeuRadarPlugin.class);   // veu amb sortida de so triable
        registerPlugin(MapesPlugin.class);      // paquets de mapa (.pmtiles) al mòbil
        super.onCreate(savedInstanceState);
    }
}
