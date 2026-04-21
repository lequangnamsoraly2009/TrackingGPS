export type TrackPoint = {
  lat: number
  lng: number
  ts: number
  accuracy: number | null
  speed: number | null
}

export type TrackMeta = {
  id: string
  name: string
  startTime: number
  endTime: number
  durationMs: number
  distanceMeters: number
}

export type SavedTrack = {
  meta: TrackMeta
  points: TrackPoint[]
}
