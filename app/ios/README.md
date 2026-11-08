# LightSurvey (Lux)

iPhone app for the TAMU Datathon night-lighting project. Every launch opens on the mode chooser. Two modes:

## Explore
- Finds the best-lit walking route between two campus places, scored from the survey's measured light.
- Turn-by-turn navigation along that route.

## Survey
- Guided night-light survey walks along assigned routes.
- Live lux readings from the camera.
- A photo every second (back camera, GPS + exposure in EXIF).
- Coverage tracked in 10 m bins along the route.
- Uploads new data to the dashboard every 5 minutes and at End.
- The Survey home lists only the assignments sent from Survey Control (website), refreshed every 15 s and on pull-to-refresh; with none it shows an empty state.
- Tapping an assignment selects that walker, loads its route and opens the pre-walk checks; the walk starts only from Start there. Resume appears only for an interrupted walk on a currently assigned route.
- Each walk is saved under Files → On My iPhone → LightSurvey → Sessions.

## Build
- Xcode 16, iOS 17+, a real iPhone (camera + GPS).
- Open LightSurvey.xcodeproj → target LightSurvey → Signing & Capabilities: set your Team and a unique Bundle Identifier.
- Run.

`tools/` holds Python helpers for processing session data (build_viewer.py, prepare_3d.py).
