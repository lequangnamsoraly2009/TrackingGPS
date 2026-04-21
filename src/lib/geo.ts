import type { TrackPoint } from '../types'

export function toTrackPoint(pos: GeolocationPosition): TrackPoint {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    ts: pos.timestamp,
    accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
    speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
  }
}

export function calcDistanceMeters(a: TrackPoint, b: TrackPoint) {
  const r = 6371000
  const dLat = degToRad(b.lat - a.lat)
  const dLng = degToRad(b.lng - a.lng)
  const p =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(a.lat)) * Math.cos(degToRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * r * Math.atan2(Math.sqrt(p), Math.sqrt(1 - p))
}

function degToRad(value: number) {
  return (value * Math.PI) / 180
}
