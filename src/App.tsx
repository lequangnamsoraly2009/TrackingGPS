import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { createTrack, listenTracks, saveLiveLocation, saveTrackPoint, updateTrackMeta } from './lib/db'
import { getDeviceId } from './lib/device'
import { calcDistanceMeters, toTrackPoint } from './lib/geo'
import type { SavedTrack, TrackMeta, TrackPoint } from './types'

type TrackingState = 'idle' | 'tracking' | 'paused'
type Tab = 'track' | 'routes' | 'settings'
type PermissionStateEx = 'unknown' | 'granted' | 'denied' | 'prompt'

function App() {
  const deviceId = useMemo(() => getDeviceId(), [])
  const [tracks, setTracks] = useState<SavedTrack[]>([])
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null)
  const [livePoint, setLivePoint] = useState<TrackPoint | null>(null)
  const [trackName, setTrackName] = useState('')
  const [state, setState] = useState<TrackingState>('idle')
  const [selectedTrack, setSelectedTrack] = useState<SavedTrack | null>(null)
  const [tab, setTab] = useState<Tab>('track')
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [permission, setPermission] = useState<PermissionStateEx>('unknown')
  const [error, setError] = useState('')

  const watchIdRef = useRef<number | null>(null)
  const activeMetaRef = useRef<TrackMeta | null>(null)
  const lastSavedPointRef = useRef<TrackPoint | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  const polylineRef = useRef<L.Polyline | null>(null)
  const mapNodeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsubscribe = listenTracks(deviceId, setTracks)
    return () => unsubscribe()
  }, [deviceId])

  useEffect(() => {
    let mounted = true
    const checkPermission = async () => {
      if (!('permissions' in navigator) || !navigator.permissions?.query) {
        return
      }
      try {
        const result = await navigator.permissions.query({ name: 'geolocation' })
        if (!mounted) {
          return
        }
        setPermission(result.state)
        result.onchange = () => {
          setPermission(result.state)
        }
      } catch {
        setPermission('unknown')
      }
    }
    checkPermission()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current) {
      return
    }

    mapRef.current = L.map(mapNodeRef.current).setView([10.8231, 106.6297], 15)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(mapRef.current)

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  const activeTrack = tracks.find((item) => item.meta.id === activeTrackId) ?? null
  const polylinePoints = selectedTrack?.points ?? activeTrack?.points ?? []
  const gpsStatus = state === 'tracking' ? 'Sharing live' : state === 'paused' ? 'Paused' : 'Not sharing'

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    if (polylineRef.current) {
      polylineRef.current.removeFrom(map)
      polylineRef.current = null
    }

    if (polylinePoints.length > 1) {
      polylineRef.current = L.polyline(polylinePoints.map((p) => [p.lat, p.lng] as [number, number]), {
        color: '#2563eb',
        weight: 4,
      }).addTo(map)
    }
  }, [polylinePoints])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !livePoint) {
      return
    }

    const latlng: [number, number] = [livePoint.lat, livePoint.lng]
    if (!markerRef.current) {
      markerRef.current = L.circleMarker(latlng, {
        radius: 7,
        color: '#1d4ed8',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.8,
      }).addTo(map)
    } else {
      markerRef.current.setLatLng(latlng)
    }

    map.setView(latlng, Math.max(16, map.getZoom()), { animate: true })
  }, [livePoint])

  const startTracking = async () => {
    setError('')
    try {
      await requestLocationPermission()
      const created = await createTrack(deviceId, trackName.trim() || `Route ${new Date().toLocaleString()}`)
      activeMetaRef.current = created.meta
      setActiveTrackId(created.id)
      setSelectedTrack(null)
      setState('tracking')
      lastSavedPointRef.current = null
      ensureWatch(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot start tracking')
    }
  }

  const requestLocationPermission = async () => {
    if (!navigator.geolocation) {
      throw new Error('GPS is not supported on this device')
    }
    await new Promise<void>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        () => {
          setPermission('granted')
          resolve()
        },
        (geoError) => {
          if (geoError.code === geoError.PERMISSION_DENIED) {
            setPermission('denied')
            reject(new Error('Bạn đã từ chối quyền GPS. Hãy bật Location để tiếp tục.'))
            return
          }
          reject(new Error(geoError.message))
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      )
    })
  }

  const pauseTracking = () => {
    stopWatch()
    setState('paused')
  }

  const resumeTracking = () => {
    if (activeTrackId) {
      ensureWatch(activeTrackId)
    }
    setState('tracking')
  }

  const stopTracking = async () => {
    stopWatch()
    const meta = activeMetaRef.current
    if (meta) {
      meta.endTime = Date.now()
      meta.durationMs = meta.endTime - meta.startTime
      await updateTrackMeta(deviceId, meta)
    }
    activeMetaRef.current = null
    setActiveTrackId(null)
    setState('idle')
  }

  const ensureWatch = (trackId: string) => {
    if (!navigator.geolocation || watchIdRef.current !== null) {
      return
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const point = toTrackPoint(position)
        setLivePoint(point)
        await saveLiveLocation(deviceId, point)
        await saveTrackPoint(deviceId, trackId, point)

        const previous = lastSavedPointRef.current
        lastSavedPointRef.current = point
        if (!previous || !activeMetaRef.current) {
          return
        }

        activeMetaRef.current.distanceMeters += calcDistanceMeters(previous, point)
        activeMetaRef.current.endTime = point.ts
        activeMetaRef.current.durationMs = activeMetaRef.current.endTime - activeMetaRef.current.startTime
        await updateTrackMeta(deviceId, activeMetaRef.current)
      },
      (watchError) => {
        setError(watchError.message)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 15000,
      },
    )
  }

  const stopWatch = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
  }

  const centerToLive = () => {
    const map = mapRef.current
    if (!map || !livePoint) {
      return
    }
    map.setView([livePoint.lat, livePoint.lng], 17, { animate: true })
  }

  return (
    <main className="app">
      <section className="mapWrap">
        <div className="map" ref={mapNodeRef} />
      </section>

      <section className="topBar">
        <div>
          <h1>GPS Tracking</h1>
          <p>{gpsStatus}</p>
        </div>
        <button className="ghostBtn" onClick={centerToLive} type="button">
          Locate
        </button>
      </section>

      <button className="fabLocate" onClick={centerToLive} type="button" aria-label="Center map">
        +
      </button>

      <section className={`bottomSheet ${sheetExpanded ? 'expanded' : 'collapsed'}`}>
        <button className="sheetHandle" type="button" onClick={() => setSheetExpanded((v) => !v)} aria-label="Toggle panel">
          <span />
        </button>

        {tab === 'track' && (
          <div className="sheetContent">
            <p className="permission">
              GPS permission:{' '}
              <strong>
                {permission === 'granted'
                  ? 'Granted'
                  : permission === 'denied'
                    ? 'Denied'
                    : permission === 'prompt'
                      ? 'Ask on Start'
                      : 'Unknown'}
              </strong>
            </p>
            <input value={trackName} onChange={(e) => setTrackName(e.target.value)} placeholder="Route name" />
            <div className="buttons">
              {state === 'idle' && <button onClick={startTracking}>Start</button>}
              {state === 'tracking' && <button onClick={pauseTracking}>Pause</button>}
              {state === 'paused' && <button onClick={resumeTracking}>Resume</button>}
              {state !== 'idle' && <button onClick={stopTracking}>Stop</button>}
            </div>
            {activeTrack && (
              <p className="meta">
                Distance: {(activeTrack.meta.distanceMeters / 1000).toFixed(2)} km - Time: {Math.floor(activeTrack.meta.durationMs / 60000)} min
              </p>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        )}

        {tab === 'routes' && (
          <div className="sheetContent">
            <h2>Saved Routes</h2>
            <ul>
              {tracks.map((track) => (
                <li key={track.meta.id}>
                  <button
                    className={selectedTrack?.meta.id === track.meta.id ? 'selected' : ''}
                    onClick={() => setSelectedTrack(track)}
                  >
                    <strong>{track.meta.name}</strong>
                    <span>{new Date(track.meta.startTime).toLocaleString()}</span>
                    <span>{(track.meta.distanceMeters / 1000).toFixed(2)} km</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === 'settings' && (
          <div className="sheetContent settings">
            <p>Device ID</p>
            <code>{deviceId}</code>
            <p>Map: OpenStreetMap</p>
            <p>Database path: sharedDBTracking</p>
          </div>
        )}
      </section>

      <nav className="footerNav" aria-label="Bottom Navigation">
        <button className={tab === 'track' ? 'active' : ''} onClick={() => setTab('track')} type="button">Track</button>
        <button className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')} type="button">Routes</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')} type="button">Settings</button>
      </nav>
    </main>
  )
}

export default App
