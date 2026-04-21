const DEVICE_KEY = 'gps_tracking_device_id'

export function getDeviceId() {
  const existing = localStorage.getItem(DEVICE_KEY)
  if (existing) {
    return existing
  }

  const generated = crypto.randomUUID()
  localStorage.setItem(DEVICE_KEY, generated)
  return generated
}
