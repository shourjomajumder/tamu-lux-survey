# LightSurvey (Lux)

iPhone app for the TAMU Datathon night-lighting project. Two modes:

## Explore
- Finds the best-lit walking route between two campus places, scored from the survey's measured light.
- Turn-by-turn navigation along that route.

## Survey
- Guided night-light survey walks along assigned routes.
- Live lux readings from the camera.
- A photo every second (back camera, GPS + exposure in EXIF).
- Coverage tracked in 10 m bins along the route.
- Uploads new data to the dashboard every 5 minutes and at End.
- Survey Control: walker names and route assignments come from the dashboard.
- Each walk is saved under Files → On My iPhone → LightSurvey → Sessions.

## Build
- Xcode 16, iOS 17+, a real iPhone (camera + GPS).
- Open LightSurvey.xcodeproj → target LightSurvey → Signing & Capabilities: set your Team and a unique Bundle Identifier.
- Run.

`tools/` holds Python helpers for processing session data (build_viewer.py, prepare_3d.py).
