import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { createTrack, listenAllLiveLocations, listenAllTracks, saveLiveLocation, saveTrackPoint, updateTrackMeta } from './lib/db'
import { calcDistanceMeters, toTrackPoint } from './lib/geo'
import currentMarkerImage from './assets/450304252_1265572144421131_3328656113765129665_n.jpg'
import altMarkerImage from './assets/448649236_461488343173256_9057384935763512322_n.jpg'
import type { SavedTrack, TrackMeta, TrackPoint } from './types'

type TrackingState = 'idle' | 'tracking'
type PermissionStateEx = 'unknown' | 'granted' | 'denied' | 'prompt'
type Profile = { id: string; label: string; pin: string; markerImage: string }
type RenderTrack = SavedTrack & { profileId: string }
type MarkerMeta = { label: string; speedKmh: number }
type WakeLockSentinel = {
  released?: boolean
  release: () => Promise<void>
  addEventListener?: (type: string, listener: () => void) => void
}
type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>
  }
}

const PROFILES: Profile[] = [
  { id: 'profile-a', label: 'Soraly', pin: '123456', markerImage: currentMarkerImage },
  { id: 'profile-b', label: 'Stacy', pin: '111111', markerImage: altMarkerImage },
]
function getMarkerIcon(image: string, markerMeta: MarkerMeta, profileId?: string) {
  return L.divIcon({
    className: `current-marker ${profileId ?? ''}`.trim(),
    html: `<div class="current-marker-label">${markerMeta.label} • ${Math.round(markerMeta.speedKmh)} km/h</div><img src="${image}" class="current-marker-image" alt="Vị trí hiện tại" />`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

function getMarkerImageByUserId(userId: string) {
  return PROFILES.find((p) => p.id === userId)?.markerImage ?? currentMarkerImage
}

function getProfileLabelByUserId(userId: string) {
  return PROFILES.find((p) => p.id === userId)?.label ?? userId
}

function getRouteColorByUserId(userId: string) {
  const palette = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2']
  if (userId === 'profile-a') return '#dc2626'
  if (userId === 'profile-b') return '#2563eb'
  let hash = 0
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return palette[hash % palette.length]
}

function App() {
  const SAVE_INTERVAL_MS = 10_000
  const [tracksByProfile, setTracksByProfile] = useState<Record<string, SavedTrack[]>>({})
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null)
  const [livePoint, setLivePoint] = useState<TrackPoint | null>(null)
  const [state, setState] = useState<TrackingState>('idle')
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [permission, setPermission] = useState<PermissionStateEx>('unknown')
  const [error, setError] = useState('')
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)
  const [showPinModal, setShowPinModal] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState('')
  const [liveByProfile, setLiveByProfile] = useState<Record<string, TrackPoint | null>>({})
  const [followedUserId, setFollowedUserId] = useState<string | null>(null)
  const [trackingOverlay, setTrackingOverlay] = useState(false)

  const watchIdRef = useRef<number | null>(null)
  const activeMetaRef = useRef<TrackMeta | null>(null)
  const lastSavedPointRef = useRef<TrackPoint | null>(null)
  const lastPersistedAtRef = useRef<number>(0)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const routesLayerRef = useRef<L.LayerGroup | null>(null)
  const liveMarkersLayerRef = useRef<L.LayerGroup | null>(null)
  const liveMarkerRefs = useRef<Record<string, L.Marker>>({})
  const mapNodeRef = useRef<HTMLDivElement | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const isUnlocked = Boolean(activeProfile)
  const markerIcon = useMemo(
    () =>
      getMarkerIcon(
        activeProfile?.markerImage ?? currentMarkerImage,
        {
          label: activeProfile?.label ?? 'Khách',
          speedKmh: Math.max(0, (livePoint?.speed ?? 0) * 3.6),
        },
        activeProfile?.id,
      ),
    [activeProfile, livePoint],
  )

  useEffect(() => {
    if (markerRef.current) {
      markerRef.current.setIcon(markerIcon)
    }
  }, [markerIcon])

  const upsertCurrentMarker = useCallback((point: TrackPoint) => {
    const map = mapRef.current
    if (!map) {
      return
    }
    const latlng: [number, number] = [point.lat, point.lng]
    if (!markerRef.current) {
      markerRef.current = L.marker(latlng, { icon: markerIcon, zIndexOffset: 1000 }).addTo(map)
      if (activeProfile) {
        markerRef.current.on('click', () => setFollowedUserId(activeProfile.id))
      }
      return
    }
    markerRef.current.setIcon(markerIcon)
    markerRef.current.setLatLng(latlng)
    if (activeProfile) {
      markerRef.current.off('click')
      markerRef.current.on('click', () => setFollowedUserId(activeProfile.id))
    }
  }, [markerIcon, activeProfile])

  useEffect(() => listenAllTracks(setTracksByProfile), [])

  useEffect(() => listenAllLiveLocations(setLiveByProfile), [])

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
    const requestWakeLock = async () => {
      const wakeNavigator = navigator as WakeLockNavigator
      if (state !== 'tracking' || typeof navigator === 'undefined' || !wakeNavigator.wakeLock?.request) {
        return
      }
      try {
        const lock = await wakeNavigator.wakeLock.request('screen')
        wakeLockRef.current = lock
        lock.addEventListener?.('release', () => {
          wakeLockRef.current = null
        })
      } catch {
        // Ignore if device/browser denies wake lock.
      }
    }

    const releaseWakeLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release()
        } catch {
          // no-op
        } finally {
          wakeLockRef.current = null
        }
      }
    }

    if (state === 'tracking') {
      void requestWakeLock()
    } else {
      void releaseWakeLock()
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && state === 'tracking') {
        void requestWakeLock()
      } else if (document.visibilityState !== 'visible') {
        void releaseWakeLock()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      void releaseWakeLock()
    }
  }, [state])

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

  const tracks = useMemo<RenderTrack[]>(() => {
    const all = Object.entries(tracksByProfile).flatMap(([profileId, userTracks]) =>
      (userTracks ?? []).map((track) => ({ ...track, profileId })),
    )
    return all.sort((a, b) => b.meta.startTime - a.meta.startTime)
  }, [tracksByProfile])
  const activeTrack = tracks.find((item) => item.meta.id === activeTrackId) ?? null
  const gpsStatus = state === 'tracking' ? 'Đang chia sẻ vị trí' : 'Chưa chia sẻ vị trí'
  const currentSpeedKmh = livePoint?.speed !== null && livePoint?.speed !== undefined ? Math.max(0, livePoint.speed * 3.6) : 0
  const speedDisplay = Math.round(currentSpeedKmh)
  const followedInfo = useMemo(() => {
    if (!followedUserId) return null
    if (activeProfile?.id === followedUserId) {
      return {
        label: activeProfile.label,
        speed: Math.max(0, (livePoint?.speed ?? 0) * 3.6),
      }
    }
    const point = liveByProfile[followedUserId]
    if (!point) return null
    return {
      label: getProfileLabelByUserId(followedUserId),
      speed: Math.max(0, (point.speed ?? 0) * 3.6),
    }
  }, [followedUserId, activeProfile, livePoint, liveByProfile])

  const followedPoint = useMemo(() => {
    if (!followedUserId) return null
    if (activeProfile?.id === followedUserId) return livePoint
    return liveByProfile[followedUserId] ?? null
  }, [followedUserId, activeProfile, livePoint, liveByProfile])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !followedPoint) {
      return
    }
    const zoom = map.getZoom()
    map.panTo([followedPoint.lat, followedPoint.lng], { animate: true, duration: 0.6 })
    if (zoom < 16) {
      map.setZoom(16, { animate: true })
    }
  }, [followedPoint])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    if (!routesLayerRef.current) {
      routesLayerRef.current = L.layerGroup().addTo(map)
    }

    routesLayerRef.current.clearLayers()
    tracks.forEach((track) => {
      if (track.points.length > 1) {
        const baseColor = getRouteColorByUserId(track.profileId)
        L.polyline(track.points.map((p) => [p.lat, p.lng] as [number, number]), {
          color: baseColor,
          weight: track.meta.id === activeTrackId ? 4 : 3,
          opacity: track.meta.id === activeTrackId ? 1 : 0.65,
        }).addTo(routesLayerRef.current as L.LayerGroup)
      }
    })
  }, [tracks, activeTrackId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !livePoint) {
      return
    }

    upsertCurrentMarker(livePoint)
    map.setView([livePoint.lat, livePoint.lng], Math.max(16, map.getZoom()), { animate: true })
  }, [livePoint, upsertCurrentMarker])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    if (!liveMarkersLayerRef.current) {
      liveMarkersLayerRef.current = L.layerGroup().addTo(map)
    }

    const layer = liveMarkersLayerRef.current
    Object.entries(liveByProfile).forEach(([userId, point]) => {
      if (activeProfile?.id === userId) {
        const existing = liveMarkerRefs.current[userId]
        if (existing) {
          layer.removeLayer(existing)
          delete liveMarkerRefs.current[userId]
        }
        return
      }

      if (!point) {
        const existing = liveMarkerRefs.current[userId]
        if (existing) {
          layer.removeLayer(existing)
          delete liveMarkerRefs.current[userId]
        }
        return
      }

      const latlng: [number, number] = [point.lat, point.lng]
      const icon = getMarkerIcon(
        getMarkerImageByUserId(userId),
        {
          label: getProfileLabelByUserId(userId),
          speedKmh: Math.max(0, (point.speed ?? 0) * 3.6),
        },
        userId,
      )
      const existing = liveMarkerRefs.current[userId]
      if (!existing) {
        liveMarkerRefs.current[userId] = L.marker(latlng, { icon, zIndexOffset: 900 }).addTo(layer)
        liveMarkerRefs.current[userId].on('click', () => setFollowedUserId(userId))
      } else {
        existing.setIcon(icon)
        existing.setLatLng(latlng)
        existing.off('click')
        existing.on('click', () => setFollowedUserId(userId))
      }
    })
  }, [activeProfile, liveByProfile])

  const startTracking = async () => {
    if (!isUnlocked) {
      setError('Tính năng vẽ tuyến đang bị khóa')
      return
    }
    setError('')
    try {
      const profileId = activeProfile?.id
      if (!profileId) {
        setError('Chưa chọn profile')
        return
      }
      await requestLocationPermission()
      const created = await createTrack(profileId, `Auto ${new Date().toLocaleString()}`)
      activeMetaRef.current = created.meta
      setActiveTrackId(created.id)
      setState('tracking')
      setTrackingOverlay(true)
      lastSavedPointRef.current = null
      lastPersistedAtRef.current = 0
      ensureWatch(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể bắt đầu theo dõi')
    }
  }

  const processIncomingPoint = async (trackId: string, point: TrackPoint) => {
    setLivePoint(point)
    if (!activeProfile) {
      return
    }

    const now = Date.now()
    const shouldPersist = lastPersistedAtRef.current === 0 || now - lastPersistedAtRef.current >= SAVE_INTERVAL_MS
    if (!shouldPersist) {
      return
    }
    lastPersistedAtRef.current = now

    await saveLiveLocation(activeProfile.id, point)
    await saveTrackPoint(activeProfile.id, trackId, point)

    const previous = lastSavedPointRef.current
    lastSavedPointRef.current = point
    if (!previous || !activeMetaRef.current) {
      return
    }

    activeMetaRef.current.distanceMeters += calcDistanceMeters(previous, point)
    activeMetaRef.current.endTime = point.ts
    activeMetaRef.current.durationMs = activeMetaRef.current.endTime - activeMetaRef.current.startTime
    await updateTrackMeta(activeProfile.id, activeMetaRef.current)
  }

  const requestLocationPermission = async () => {
    if (!navigator.geolocation) {
      throw new Error('Thiết bị không hỗ trợ GPS')
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

  const stopTracking = async () => {
    if (!isUnlocked) {
      return
    }
    stopWatch()
    const profileId = activeProfile?.id
    const meta = activeMetaRef.current
    if (meta && profileId) {
      meta.endTime = livePoint?.ts ?? meta.endTime
      meta.durationMs = meta.endTime - meta.startTime
      await updateTrackMeta(profileId, meta)
    }
    activeMetaRef.current = null
    setActiveTrackId(null)
    setState('idle')
    setTrackingOverlay(false)
  }

  const ensureWatch = (trackId: string) => {
    if (!navigator.geolocation || watchIdRef.current !== null) {
      return
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const point = toTrackPoint(position)
        await processIncomingPoint(trackId, point)
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
    if (!isUnlocked) {
      setError('Chế độ chỉ xem: cần mở khóa để thao tác')
      return
    }
    void panToCurrentPosition()
  }

  const panToCurrentPosition = async () => {
    const map = mapRef.current
    if (!map) {
      setError('Bản đồ chưa sẵn sàng')
      return false
    }
    map.invalidateSize()
    if (livePoint) {
      upsertCurrentMarker(livePoint)
      map.flyTo([livePoint.lat, livePoint.lng], 17, { animate: true, duration: 0.6 })
      return true
    }
    if (!navigator.geolocation) {
      setError('Thiết bị không hỗ trợ GPS')
      return false
    }
    try {
      const point = await new Promise<TrackPoint>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (position) => resolve(toTrackPoint(position)),
          (geoError) => reject(new Error(geoError.message)),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        )
      })
      setLivePoint(point)
      upsertCurrentMarker(point)
      map.flyTo([point.lat, point.lng], 17, { animate: true, duration: 0.6 })
      return true
    } catch (geoError) {
      setError(geoError instanceof Error ? geoError.message : 'Không thể lấy vị trí hiện tại')
      return false
    }
  }

  const syncLiveLocationNow = async (profileId: string) => {
    try {
      const point = await new Promise<TrackPoint>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Thiết bị không hỗ trợ GPS'))
          return
        }
        navigator.geolocation.getCurrentPosition(
          (position) => resolve(toTrackPoint(position)),
          (geoError) => reject(new Error(geoError.message)),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        )
      })
      setLivePoint(point)
      await saveLiveLocation(profileId, point)
      upsertCurrentMarker(point)
      mapRef.current?.flyTo([point.lat, point.lng], 17, { animate: true, duration: 0.6 })
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Không thể cập nhật vị trí hiện tại')
    }
  }

  const openPinModal = () => {
    setPinInput('')
    setPinError('')
    setShowPinModal(true)
  }

  return (
    <main className="app">
      <section className="mapWrap">
        <div className="map" ref={mapNodeRef} />
      </section>

      <section className="topBar" onClick={openPinModal}>
        <div>
          <h1>Theo dõi GPS</h1>
          <p>
            {followedInfo
              ? `Đang theo dõi: ${followedInfo.label} - ${Math.round(followedInfo.speed)} km/h`
              : isUnlocked
                ? `${gpsStatus} - ${activeProfile?.label}`
                : 'Chế độ chỉ xem tuyến đường'}
          </p>
        </div>
        <span className={`lockBadge ${isUnlocked ? 'ok' : ''}`}>{isUnlocked ? 'Đã mở khóa' : 'Đang khóa'}</span>
      </section>

      <button className="fabLocate" onClick={centerToLive} type="button" aria-label="Vị trí hiện tại" disabled={!isUnlocked}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 2a1 1 0 0 1 1 1v1.06a8 8 0 0 1 6.94 6.94H21a1 1 0 1 1 0 2h-1.06a8 8 0 0 1-6.94 6.94V21a1 1 0 1 1-2 0v-1.06a8 8 0 0 1-6.94-6.94H3a1 1 0 1 1 0-2h1.06a8 8 0 0 1 6.94-6.94V3a1 1 0 0 1 1-1Zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"
            fill="currentColor"
          />
        </svg>
      </button>
      <div className="speedSign" aria-label={`Tốc độ hiện tại ${speedDisplay} km/h`}>
        <div className="speedSignInner">{speedDisplay}</div>
      </div>

      {trackingOverlay && (
        <div className="trackingOverlay" aria-hidden="true">
          <button type="button" className="trackingOverlayStop" onClick={stopTracking}>
            Kết thúc
          </button>
        </div>
      )}

      <section className={`bottomSheet ${sheetExpanded ? 'expanded' : 'collapsed'}`}>
        <button className="sheetHandle" type="button" onClick={() => setSheetExpanded((v) => !v)} aria-label="Toggle panel">
          <span />
        </button>
        <div className="sheetContent">
          {isUnlocked && (
            <>
              <p className="permission">
                Quyền GPS:{' '}
                <strong>
                  {permission === 'granted'
                    ? 'Đã cấp'
                    : permission === 'denied'
                      ? 'Từ chối'
                      : permission === 'prompt'
                        ? 'Hỏi khi bắt đầu'
                        : 'Không rõ'}
                </strong>
              </p>
              <div className="buttons">
                {state === 'idle' && <button onClick={startTracking}>Bắt đầu</button>}
                {state !== 'idle' && <button onClick={stopTracking}>Kết thúc</button>}
              </div>
              {activeTrack && (
                <p className="meta">
                  Quãng đường: {(activeTrack.meta.distanceMeters / 1000).toFixed(2)} km - Thời gian: {Math.floor(activeTrack.meta.durationMs / 60000)} phút
                </p>
              )}
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      </section>

      {showPinModal && (
        <div className="pinModalBackdrop" role="dialog" aria-modal="true" aria-label="Nhập mật khẩu mở khóa">
          <div className="pinModal">
            <h3>Mở khóa vẽ tuyến</h3>
            <p>Nhập mật khẩu 6 số để chọn profile</p>
            <input
              className="pinInput"
              value={pinInput}
              onChange={(e) => {
                const value = e.target.value.replace(/\D/g, '').slice(0, 6)
                setPinInput(value)
                if (value.length === 6) {
                  const matched = PROFILES.find((profile) => profile.pin === value)
                  if (matched) {
                    stopWatch()
                    activeMetaRef.current = null
                    setActiveTrackId(null)
                    setState('idle')
                    setLivePoint(null)
                    markerRef.current?.remove()
                    markerRef.current = null
                    setActiveProfile(matched)
                    setShowPinModal(false)
                    setPinError('')
                    setError('')
                    void syncLiveLocationNow(matched.id)
                    return
                  }
                  setPinError('Mật khẩu không đúng')
                } else {
                  setPinError('')
                }
              }}
              inputMode="numeric"
              placeholder="******"
            />
            {pinError && <p className="error">{pinError}</p>}
            <div className="pinActions">
              <button type="button" onClick={() => setShowPinModal(false)}>Hủy</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
