# 2026 photo albums

Photos from the "Final" folder of each 2026 event (Eddie's CNB 2026 drive), shown in the Photo Gallery
of the full preview (`/preview`). Each album folder holds `NNN.jpg` (1400 px, for full-size view and
download) and `NNNt.jpg` (480 px thumbnail). Photo metadata (camera, GPS) is stripped.

`2026/albums.json` lists each album: folder key, event name, date (from the photos' camera date), market,
photo count and the source folder on the drive. Photos are served only to signed-in people
(`/preview/photos/...`), never as public static files.

To add or replace an album, put the resized photos in a new `MM-event-name` folder and add a line to
`albums.json`.
