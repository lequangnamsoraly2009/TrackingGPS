import { onValue, push, ref, set } from 'firebase/database'
import { db } from './firebase'
import type { SavedTrack, TrackMeta, TrackPoint } from '../types'

const ROOT = 'sharedDBTracking'

export function createTrack(deviceId: string, name: string) {
  const tracksRef = ref(db, `${ROOT}/gpsTracks/${deviceId}`)
  const created = push(tracksRef)
  const id = created.key
  if (!id) {
    throw new Error('Unable to create track id')
  }

  const now = Date.now()
  const meta: TrackMeta = {
    id,
    name,
    startTime: now,
    endTime: now,
    durationMs: 0,
    distanceMeters: 0,
  }

  return set(ref(db, `${ROOT}/gpsTracks/${deviceId}/${id}/meta`), meta).then(() => ({ id, meta }))
}

export function saveTrackPoint(deviceId: string, trackId: string, point: TrackPoint) {
  const pointsRef = ref(db, `${ROOT}/gpsTracks/${deviceId}/${trackId}/points`)
  return set(push(pointsRef), point)
}

export function saveLiveLocation(deviceId: string, point: TrackPoint) {
  return set(ref(db, `${ROOT}/liveLocation/${deviceId}`), point)
}

export function listenLiveLocation(deviceId: string, cb: (point: TrackPoint | null) => void) {
  const liveRef = ref(db, `${ROOT}/liveLocation/${deviceId}`)
  return onValue(liveRef, (snapshot) => {
    const value = snapshot.val() as TrackPoint | null
    cb(value ?? null)
  })
}

export function updateTrackMeta(deviceId: string, meta: TrackMeta) {
  return set(ref(db, `${ROOT}/gpsTracks/${deviceId}/${meta.id}/meta`), meta)
}

export function listenTracks(deviceId: string, cb: (tracks: SavedTrack[]) => void) {
  const tracksRef = ref(db, `${ROOT}/gpsTracks/${deviceId}`)
  return onValue(tracksRef, (snapshot) => {
    const raw = snapshot.val() as
      | Record<string, { meta?: TrackMeta; points?: Record<string, TrackPoint> }>
      | null

    if (!raw) {
      cb([])
      return
    }

    const tracks = Object.values(raw)
      .filter((item) => item.meta)
      .map((item) => {
        const points = item.points ? Object.values(item.points).sort((a, b) => a.ts - b.ts) : []
        return { meta: item.meta as TrackMeta, points }
      })
      .sort((a, b) => b.meta.startTime - a.meta.startTime)

    cb(tracks)
  })
}

export function listenAllTracks(cb: (tracksByUser: Record<string, SavedTrack[]>) => void) {
  const tracksRef = ref(db, `${ROOT}/gpsTracks`)
  return onValue(tracksRef, (snapshot) => {
    const raw = snapshot.val() as
      | Record<string, Record<string, { meta?: TrackMeta; points?: Record<string, TrackPoint> }>>
      | null

    if (!raw) {
      cb({})
      return
    }

    const result: Record<string, SavedTrack[]> = {}
    Object.entries(raw).forEach(([userId, tracksObj]) => {
      const tracks = Object.values(tracksObj ?? {})
        .filter((item) => item.meta)
        .map((item) => {
          const points = item.points ? Object.values(item.points).sort((a, b) => a.ts - b.ts) : []
          return { meta: item.meta as TrackMeta, points }
        })
        .sort((a, b) => b.meta.startTime - a.meta.startTime)
      result[userId] = tracks
    })
    cb(result)
  })
}

export function listenAllLiveLocations(cb: (liveByUser: Record<string, TrackPoint | null>) => void) {
  const liveRef = ref(db, `${ROOT}/liveLocation`)
  return onValue(liveRef, (snapshot) => {
    const raw = snapshot.val() as Record<string, TrackPoint> | null
    if (!raw) {
      cb({})
      return
    }
    const result: Record<string, TrackPoint | null> = {}
    Object.entries(raw).forEach(([userId, point]) => {
      result[userId] = point ?? null
    })
    cb(result)
  })
}
