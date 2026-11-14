import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { REGION, ZONES, toXY, fromXY, compass } from '@emberwatch/shared';

export const STATUS_COLORS = ['#71717a', '#eab308', '#ef4444', '#3f3f46'];

export default function SensorMap({
  devices,
  alerts,
  selected,
  zone,
  onSelect,
  igniteMode,
  onIgnite,
  heat = true,
}) {
  const element = useRef(null),
    instance = useRef(null),
    markers = useRef(new Map()),
    canvas = useRef(null),
    arrows = useRef(null);
  const latest = useRef({ devices, alerts, selected, onSelect, igniteMode, onIgnite, heat });
  latest.current = { devices, alerts, selected, onSelect, igniteMode, onIgnite, heat };
  const [tileError, setTileError] = useState(false);
  const drawHeat = () => {
    const map = instance.current,
      surface = canvas.current;
    if (!map || !surface) return;
    const size = map.getSize(),
      ratio = Math.min(window.devicePixelRatio || 1, 2);
    surface.width = size.x * ratio;
    surface.height = size.y * ratio;
    surface.style.width = `${size.x}px`;
    surface.style.height = `${size.y}px`;
    L.DomUtil.setPosition(surface, map.containerPointToLayerPoint([0, 0]));
    const ctx = surface.getContext('2d');
    ctx.scale(ratio, ratio);
    if (!latest.current.heat) return;
    for (const st of latest.current.devices) {
      if (st.type !== 'sensor' || st.status === 3 || st.t === null) continue;
      const weight = Math.min(1, Math.max((st.t - 38) / 55, (st.s ?? 0) / 450));
      if (weight < 0.06) continue;
      const p = map.latLngToContainerPoint([st.lat, st.lng]),
        radius = 28 + weight * 68;
      if (p.x < -radius || p.y < -radius || p.x > size.x + radius || p.y > size.y + radius)
        continue;
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      gradient.addColorStop(0, `rgba(249,90,24,${weight * 0.48})`);
      gradient.addColorStop(0.45, `rgba(234,166,8,${weight * 0.24})`);
      gradient.addColorStop(1, 'rgba(234,166,8,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
    }
  };
  useEffect(() => {
    const map = L.map(element.current, {
      preferCanvas: true,
      zoomControl: false,
      minZoom: 10,
      maxZoom: 18,
    });
    instance.current = map;
    const bounds = [
      [REGION.south, REGION.west],
      [REGION.north, REGION.east],
    ];
    map.fitBounds(bounds, { padding: [14, 14] });
    map.setMaxBounds(L.latLngBounds(bounds).pad(0.7));
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    const tiles = L.tileLayer(
      import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution:
          import.meta.env.VITE_TILE_ATTRIBUTION ||
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        className: 'basemap-dark',
        maxZoom: 19,
      },
    ).addTo(map);
    tiles.on('tileerror', () => setTileError(true));
    map.createPane('heat');
    map.getPane('heat').style.zIndex = '390';
    map.getPane('heat').style.pointerEvents = 'none';
    canvas.current = L.DomUtil.create('canvas', 'heat-canvas', map.getPane('heat'));
    for (const z of ZONES) {
      const b = z.bounds;
      L.rectangle(
        [
          [b.south, b.west],
          [b.north, b.east],
        ],
        {
          color: '#55555e',
          opacity: 0.45,
          weight: 1,
          dashArray: '5 7',
          fill: false,
          interactive: false,
        },
      ).addTo(map);
      const label = document.createElement('span');
      label.textContent = `ZONE ${z.name.toUpperCase()}`;
      L.marker([b.north - 0.0015, b.west + 0.0015], {
        interactive: false,
        icon: L.divIcon({
          className: 'zone-label',
          html: label,
          iconSize: [120, 20],
          iconAnchor: [0, 0],
        }),
      }).addTo(map);
    }
    arrows.current = L.layerGroup().addTo(map);
    map.on('move zoom resize', drawHeat);
    map.on('click', (event) => {
      if (latest.current.igniteMode) latest.current.onIgnite(event.latlng);
    });
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      drawHeat();
    });
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      markers.current.clear();
      map.remove();
      instance.current = null;
      canvas.current = null;
    };
  }, []);
  useEffect(() => {
    const map = instance.current;
    if (!map) return;
    const present = new Set(devices.map((d) => d.id));
    for (const [id, marker] of markers.current)
      if (!present.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    for (const st of devices) {
      let marker = markers.current.get(st.id);
      const radius =
        st.id === selected
          ? 6
          : st.type === 'station'
            ? 4
            : st.status === 2
              ? 4.5
              : st.status === 1
                ? 3.8
                : 2.6;
      const style = {
        radius,
        color: st.id === selected ? '#fb923c' : '#09090b',
        weight: st.id === selected ? 2 : 1,
        fillColor: STATUS_COLORS[st.status] || STATUS_COLORS[0],
        fillOpacity: st.status === 3 ? 0.6 : 0.95,
        bubblingMouseEvents: false,
      };
      if (!marker) {
        marker = L.circleMarker([st.lat, st.lng], style).addTo(map);
        marker.on('click', (event) => {
          L.DomEvent.stopPropagation(event.originalEvent);
          if (latest.current.igniteMode) latest.current.onIgnite({ lat: st.lat, lng: st.lng });
          else latest.current.onSelect(st.id);
        });
        markers.current.set(st.id, marker);
      } else marker.setStyle(style);
      const tooltip = document.createElement('span');
      tooltip.textContent = `${st.id} · ${st.t == null ? 'No reading' : `${st.t.toFixed(1)} °C`} · ${['Normal', 'Elevated', 'Critical', 'Offline'][st.status]}`;
      if (marker.getTooltip()) marker.setTooltipContent(tooltip);
      else marker.bindTooltip(tooltip, { direction: 'top', className: 'sensor-tooltip' });
    }
    arrows.current.clearLayers();
    for (const alert of alerts
      .filter(
        (a) =>
          a.type === 'ignition' && a.state !== 'resolved' && Number.isFinite(a.spread?.bearing),
      )
      .slice(0, 12)) {
      const st = devices.find((d) => d.id === alert.sid);
      if (!st) continue;
      const p = toXY(st),
        angle = (alert.spread.bearing * Math.PI) / 180,
        length = 600;
      const tip = { x: p.x + Math.sin(angle) * length, y: p.y + Math.cos(angle) * length };
      const end = fromXY(tip),
        start = fromXY(p);
      L.polyline(
        [
          [start.lat, start.lng],
          [end.lat, end.lng],
        ],
        { color: '#fafafa', dashArray: '5 6', weight: 2, interactive: false },
      ).addTo(arrows.current);
      const wings = [-0.55, 0.55].map((offset) =>
        fromXY({
          x: tip.x - Math.sin(angle + offset) * 110,
          y: tip.y - Math.cos(angle + offset) * 110,
        }),
      );
      L.polyline(
        [
          [wings[0].lat, wings[0].lng],
          [end.lat, end.lng],
          [wings[1].lat, wings[1].lng],
        ],
        { color: '#fafafa', weight: 2, interactive: false },
      ).addTo(arrows.current);
      const label = document.createElement('span');
      label.textContent = `Apparent spread ${compass(alert.spread.bearing)}${Number.isFinite(alert.spread.kmh) ? ` · ~${alert.spread.kmh} km/h` : ''}`;
      L.marker([end.lat, end.lng], {
        interactive: false,
        icon: L.divIcon({ className: 'spread-label', html: label, iconSize: [190, 30] }),
      }).addTo(arrows.current);
    }
    drawHeat();
  }, [devices, alerts, selected, heat]);
  useEffect(() => {
    const map = instance.current;
    if (!map) return;
    const b = ZONES.find((z) => z.id === zone)?.bounds || REGION;
    map.fitBounds(
      [
        [b.south, b.west],
        [b.north, b.east],
      ],
      { padding: [20, 20], animate: false },
    );
  }, [zone]);
  return (
    <div className={`map-wrap ${igniteMode ? 'ignite-mode' : ''}`}>
      <div
        ref={element}
        className="sensor-map"
        aria-label="Interactive simulated forest sensor map"
      />
      <div className="map-legend">
        <span>
          <i style={{ background: STATUS_COLORS[0] }} />
          Normal
        </span>
        <span>
          <i style={{ background: STATUS_COLORS[1] }} />
          Elevated
        </span>
        <span>
          <i style={{ background: STATUS_COLORS[2] }} />
          Critical
        </span>
        <span>
          <i style={{ background: STATUS_COLORS[3] }} />
          Offline
        </span>
      </div>
      {tileError && (
        <span className="tile-error">Basemap unavailable · sensor overlay remains live</span>
      )}
      {igniteMode && (
        <div className="map-instruction">Select a point inside the monitored forest to ignite.</div>
      )}
    </div>
  );
}
