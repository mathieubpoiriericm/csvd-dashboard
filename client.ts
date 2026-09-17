// Import CSS here so hot module reloading picks up stylesheet edits.
//
// Vendor first, app last. app.css recolours Leaflet and markercluster at the
// same specificity as their own rules, so it only wins if it comes after them:
// with the previous order the cluster bubbles kept markercluster's default
// green and the app's accent never applied.
import "npm:leaflet@1.9.4/dist/leaflet.css";
import "npm:leaflet.markercluster@1.5.3/dist/MarkerCluster.css";
import "npm:leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css";
import "./assets/app.css";
