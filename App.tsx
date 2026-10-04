import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MapView, { Marker, Polyline, Region, UrlTile } from "react-native-maps";
import * as Location from "expo-location";

// Speicher für "Meine Routen" (einmalig: npx expo install @react-native-async-storage/async-storage)
let Storage: any = null;
try {
  Storage = require("@react-native-async-storage/async-storage").default;
} catch {}

/* ───────────────────────── Typen & Konstanten ───────────────────────── */

type Coord = { latitude: number; longitude: number };
type Tab = "map" | "routes" | "add" | "friends" | "profile";
type MapStyle = "modern" | "dark" | "satellite" | "hybrid";
type Vehicle = 25 | 45;
type Kind = "forest" | "water" | "view" | "park";
type IconName = string;

type Poi = { id: string; kind: Kind; name: string; c: Coord; r: number };
type Stop = { c: Coord; kind: Kind; name: string };
type PlannedRoute = {
  id: string;
  name: string;
  emoji: string;
  coords: Coord[];
  km: number;
  score: number;
  kinds: Kind[];
  highlights: string[];
  stops: Stop[];
  steps: any[];
  loop: boolean;
  custom?: boolean;
};
type Active = {
  name: string;
  sub: string;
  coords: Coord[];
  km: number;
  steps: any[];
  stops: Stop[];
  dest?: Coord;
  color: string;
};

const C = {
  primary: "#1479FF",
  green: "#10B981",
  purple: "#7C5CFC",
  ink: "#0F1720",
  sub: "#6B7480",
  line: "#E6EAF0",
  bg: "#F4F6FA",
};

const KINDS: Record<Kind, { label: string; icon: IconName; color: string; bg: string; emoji: string }> = {
  forest: { label: "Wald", icon: "leaf", color: "#12B76A", bg: "#E6F8EF", emoji: "🌲" },
  water: { label: "See", icon: "water", color: "#2E90FA", bg: "#E8F2FF", emoji: "💧" },
  view: { label: "Aussicht", icon: "eye", color: "#F79009", bg: "#FFF3E0", emoji: "⛰️" },
  park: { label: "Park", icon: "flower", color: "#EE46BC", bg: "#FDEBF8", emoji: "🌳" },
};
const KIND_LIST: Kind[] = ["forest", "water", "view", "park"];

const TILES: Record<string, string> = {
  modern: "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
  dark: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
};
const STYLE_ORDER: MapStyle[] = ["modern", "dark", "satellite", "hybrid"];
const STYLE_LABEL: Record<MapStyle, string> = {
  modern: "Modern",
  dark: "Dunkel",
  satellite: "Satellit",
  hybrid: "Hybrid",
};

const MUNICH = {
  latitude: 48.1351,
  longitude: 11.582,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

const STORE_KEY = "mopedride.routes.v1";
const SCENIC_RADIUS_KM = 12;

/* ───────────────────────── Hilfsfunktionen ───────────────────────── */

const toRad = (d: number) => (d * Math.PI) / 180;

function distM(a: Coord, b: Coord) {
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// schnelle Näherung für viele Vergleiche (Routenfortschritt, Natur-Check)
function fastM(a: Coord, b: Coord) {
  const dy = (b.latitude - a.latitude) * 111320;
  const dx = (b.longitude - a.longitude) * 111320 * Math.cos(toRad(a.latitude));
  return Math.sqrt(dx * dx + dy * dy);
}

function bearingDeg(a: Coord, b: Coord) {
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// Kürzester Weg zwischen zwei Winkeln (kein Rückwärtsdrehen bei 359° -> 1°)
function smoothAngle(prev: number, next: number, factor = 0.3) {
  const diff = ((next - prev + 540) % 360) - 180;
  return (prev + diff * factor + 360) % 360;
}

// realistische Fahrzeit: Mofa/Moped schaffen im Schnitt ca. 85 % der Höchstgeschwindigkeit
const minutesFor = (km: number, v: Vehicle) => (km / (v * 0.85)) * 60;

function fmtMin(m: number) {
  const r = Math.round(m);
  if (r < 60) return `${r} Min.`;
  return `${Math.floor(r / 60)} Std. ${r % 60} Min.`;
}

function clock(minAhead: number) {
  const d = new Date(Date.now() + minAhead * 60000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function thin(coords: Coord[], max = 500) {
  if (coords.length <= max) return coords;
  const step = coords.length / max;
  const out: Coord[] = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.floor(i * step)]);
  out.push(coords[coords.length - 1]);
  return out;
}

function trimSteps(steps: any[]) {
  return steps.map((s) => ({
    name: s.name ?? "",
    maneuver: {
      type: s.maneuver?.type,
      modifier: s.maneuver?.modifier,
      location: s.maneuver?.location,
    },
  }));
}

async function fetchTimeout(url: string, init: any = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function decodePolyline6(encoded: string): Coord[] {
  const points: Coord[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ latitude: lat / 1e6, longitude: lon / 1e6 });
  }
  return points;
}

function instructionModifier(text: string) {
  const t = text.toLowerCase();
  if (t.includes('wende')) return 'uturn';
  if (t.includes('links halten') || t.includes('leicht links')) return 'slight left';
  if (t.includes('rechts halten') || t.includes('leicht rechts')) return 'slight right';
  if (t.includes('links')) return 'left';
  if (t.includes('rechts')) return 'right';
  return 'straight';
}

const MOD: Record<string, [string, string]> = {
  left: ["↰", "Links abbiegen"],
  right: ["↱", "Rechts abbiegen"],
  "slight left": ["↖", "Leicht links halten"],
  "slight right": ["↗", "Leicht rechts halten"],
  "sharp left": ["↰", "Scharf links abbiegen"],
  "sharp right": ["↱", "Scharf rechts abbiegen"],
  uturn: ["↶", "Wenden"],
  straight: ["↑", "Geradeaus weiter"],
};

function describeStep(s: any) {
  const instruction = String(s?.instruction ?? '').trim();
  if (instruction) {
    const lower = instruction.toLowerCase();
    if (lower.includes('ziel erreicht') || lower.includes('arrive')) return { arrow: '●', text: 'Ziel erreicht' };
    if (lower.includes('kreisverkehr')) return { arrow: '↻', text: instruction };
    const mod = instructionModifier(instruction);
    return { arrow: MOD[mod]?.[0] ?? '↑', text: instruction };
  }
  const t = s?.maneuver?.type;
  const m = s?.maneuver?.modifier;
  const n = s?.name;
  if (t === 'arrive') return { arrow: '●', text: 'Ziel erreicht' };
  if (t === 'roundabout' || t === 'rotary') return { arrow: '↻', text: n ? `Kreisverkehr, weiter auf ${n}` : 'In den Kreisverkehr' };
  const hit = m ? MOD[m] : undefined;
  if (hit) return { arrow: hit[0], text: m === 'straight' && n ? `Geradeaus auf ${n}` : hit[1] };
  return { arrow: '↑', text: n ? `Geradeaus auf ${n}` : 'Geradeaus weiter' };
}

/* ───────────────────────── Routing & Naturdaten ───────────────────────── */

// Routing über Valhalla motor_scooter – für Mofa/Moped ausgelegt; Highways werden deaktiviert
async function osrmRoute(points: Coord[]) {
  if (points.length < 2) return null;

  const payload = {
    locations: points.map((p) => ({
      lat: p.latitude,
      lon: p.longitude,
      type: 'break',
      radius: 100,
    })),
    costing: 'motor_scooter',
    costing_options: {
      motor_scooter: {
        top_speed: vehicleForRouting,
        use_primary: routeModeForRouting === 'scenic' ? 0.15 : 0.35,
        use_highways: 0,
      },
    },
    directions_options: {
      units: 'kilometers',
      language: 'de-DE',
      narrative: true,
    },
  };

  const endpoints = [
    'https://valhalla.openstreetmap.de/route',
    'https://valhalla1.openstreetmap.de/route',
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetchTimeout(endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, 30000);
      const raw = await res.text();
      let data: any = null;
      try { data = JSON.parse(raw); } catch {}
      if (!res.ok || data?.error || !data?.trip?.legs?.length) continue;

      const coords: Coord[] = data.trip.legs.flatMap((leg: any) =>
        typeof leg?.shape === 'string' ? decodePolyline6(leg.shape) : []
      );
      if (coords.length < 2) continue;

      const maneuvers = data.trip.legs.flatMap((leg: any) => leg?.maneuvers ?? []);
      const steps = maneuvers.map((m: any) => {
        const text = String(m?.instruction ?? m?.verbal_pre_transition_instruction ?? m?.verbal_post_transition_instruction ?? '');
        const shapeIndex = Number(m?.begin_shape_index ?? 0);
        const p = coords[Math.max(0, Math.min(coords.length - 1, shapeIndex))];
        return {
          name: String(m?.street_names?.[0] ?? ''),
          instruction: text,
          maneuver: {
            type: text.toLowerCase().includes('ziel') ? 'arrive' : 'turn',
            modifier: instructionModifier(text),
            location: p ? [p.longitude, p.latitude] : undefined,
          },
        };
      });

      const summary = data.trip.summary ?? {};
      const km = Number(summary.length);
      if (!Number.isFinite(km) || km <= 0) continue;

      return { coords, km, steps };
    } catch {}
  }

  return null;
}

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpass(query: string) {
  for (const url of OVERPASS) {
    try {
      const res = await fetchTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        },
        25000
      );
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

function parsePois(json: any): Poi[] {
  const out: Poi[] = [];
  for (const el of json?.elements ?? []) {
    const t = el.tags ?? {};
    const kind: Kind | null =
      t.tourism === "viewpoint"
        ? "view"
        : t.natural === "water"
        ? "water"
        : t.leisure === "park"
        ? "park"
        : t.landuse === "forest" || t.natural === "wood"
        ? "forest"
        : null;
    if (!kind) continue;
    let c: Coord;
    let r: number;
    if (el.bounds) {
      const b = el.bounds;
      c = { latitude: (b.minlat + b.maxlat) / 2, longitude: (b.minlon + b.maxlon) / 2 };
      const diag = distM(
        { latitude: b.minlat, longitude: b.minlon },
        { latitude: b.maxlat, longitude: b.maxlon }
      );
      r = Math.min(2500, (diag / 2) * 0.7);
    } else if (typeof el.lat === "number") {
      c = { latitude: el.lat, longitude: el.lon };
      r = 80;
    } else continue;
    if (kind === "forest" && r < 180) continue;
    const generic =
      kind === "forest" ? "Waldgebiet" : kind === "view" ? "Aussichtspunkt" : kind === "water" ? "Gewässer" : "Park";
    out.push({ id: `${el.type}${el.id}`, kind, name: t.name ?? generic, c, r });
  }
  return out;
}

async function loadPois(c: Coord, radiusM: number): Promise<Poi[] | null> {
  const a = `(around:${radiusM},${c.latitude},${c.longitude})`;
  const natureQ = `[out:json][timeout:25];(node["tourism"="viewpoint"]${a};way["natural"="water"]["name"]${a};relation["natural"="water"]["name"]${a};way["leisure"="park"]["name"]${a};);out bb 220;`;
  const forestQ = `[out:json][timeout:25];(way["landuse"="forest"]${a};way["natural"="wood"]${a};);out bb 160;`;
  const [n, f] = await Promise.all([overpass(natureQ), overpass(forestQ)]);
  if (!n && !f) return null;
  const forests = parsePois(f)
    .sort((x, y) => y.r - x.r)
    .slice(0, 45);
  return [...parsePois(n), ...forests];
}

const WEIGHT: Record<Kind, number> = { water: 3, view: 2.6, forest: 2, park: 1.4 };

function nearNature(p: Coord, pois: Poi[]) {
  return pois.some((q) => fastM(p, q.c) <= q.r + 150);
}

// Sucht Dreiecks-Rundtouren (Start → Ziel A → Ziel B → Start) zwischen den schönsten Orten
function makeCandidates(start: Coord, pois: Poi[], maxKm: number) {
  const anchors = pois
    .filter((p) => {
      const d = distM(start, p.c) / 1000;
      return d >= 2 && d <= maxKm - 1;
    })
    .map((p) => ({ p, w: WEIGHT[p.kind] + Math.min(2, p.r / 800) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 26)
    .map((x) => x.p);

  const combos: { a: Poi; b: Poi; s: number }[] = [];
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const a = anchors[i];
      const b = anchors[j];
      const dab = distM(a.c, b.c) / 1000;
      if (dab < 1.2 || dab > 9) continue;
      const ang = angleDiff(bearingDeg(start, a.c), bearingDeg(start, b.c));
      if (ang < 35 || ang > 165) continue;
      let s = WEIGHT[a.kind] + WEIGHT[b.kind] + (a.kind !== b.kind ? 1.5 : 0);
      const segs: [Coord, Coord][] = [
        [start, a.c],
        [a.c, b.c],
        [b.c, start],
      ];
      for (const [p, q] of segs) {
        for (let k = 1; k < 6; k++) {
          const t = k / 6;
          const m = {
            latitude: p.latitude + (q.latitude - p.latitude) * t,
            longitude: p.longitude + (q.longitude - p.longitude) * t,
          };
          if (nearNature(m, pois)) s += 0.3;
        }
      }
      combos.push({ a, b, s });
    }
  }
  combos.sort((x, y) => y.s - x.s);

  const near = (p: Poi, q: Poi) => distM(p.c, q.c) < 1500;
  const chosen: { a: Poi; b?: Poi }[] = [];
  for (const cb of combos) {
    const clash = chosen.some(
      (ch) =>
        near(ch.a, cb.a) ||
        near(ch.a, cb.b) ||
        (ch.b ? near(ch.b, cb.a) || near(ch.b, cb.b) : false)
    );
    if (clash) continue;
    chosen.push({ a: cb.a, b: cb.b });
    if (chosen.length >= 5) break;
  }
  if (chosen.length < 3) {
    for (const p of anchors) {
      if (chosen.some((ch) => near(ch.a, p) || (ch.b ? near(ch.b, p) : false))) continue;
      chosen.push({ a: p });
      if (chosen.length >= 4) break;
    }
  }
  return chosen;
}

// Natur-Score: wie viel der Strecke führt an Wald / Wasser / Park / Aussicht vorbei
function scoreRoute(coords: Coord[], pois: Poi[]) {
  const n = Math.min(80, coords.length);
  let hits = 0;
  const kinds: Kind[] = [];
  const names: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const p = coords[Math.floor((i * (coords.length - 1)) / Math.max(1, n - 1))];
    let best: Poi | null = null;
    for (const poi of pois) {
      if (fastM(p, poi.c) <= poi.r + 150) {
        best = poi;
        if (poi.kind === "water" || poi.kind === "view") break;
      }
    }
    if (best) {
      hits++;
      if (!kinds.includes(best.kind)) kinds.push(best.kind);
      names[best.name] = (names[best.name] ?? 0) + 1;
    }
  }
  const share = hits / n;
  const score = Math.max(5, Math.min(99, Math.round(share * 100 * 1.15 + kinds.length * 3)));
  const highlights = Object.keys(names)
    .sort((a, b) => names[b] - names[a])
    .slice(0, 3);
  return { score, kinds, highlights };
}

function titleFor(list: Poi[]) {
  const named = (p: Poi) => !["Waldgebiet", "Gewässer", "Park", "Aussichtspunkt"].includes(p.name);
  const w = list.find((p) => p.kind === "water");
  const v = list.find((p) => p.kind === "view");
  const f = list.find((p) => p.kind === "forest");
  const pk = list.find((p) => p.kind === "park");
  if (w) return { emoji: "💧", name: named(w) ? `Seerunde: ${w.name}` : "Runde am Wasser" };
  if (v) return { emoji: "⛰️", name: named(v) ? `Aussicht: ${v.name}` : "Aussichtstour" };
  if (f) return { emoji: "🌲", name: named(f) ? `Waldrunde: ${f.name}` : "Waldrunde" };
  return { emoji: "🌳", name: pk && named(pk) ? `Parkrunde: ${pk.name}` : "Grüne Runde" };
}

function scoreColor(s: number) {
  return s >= 70 ? "#12B76A" : s >= 45 ? "#F79009" : "#98A2B3";
}

function subFor(r: PlannedRoute) {
  const k = r.kinds.map((x) => KINDS[x].label).join(" · ");
  return r.custom ? `Eigene Route${k ? " · " + k : ""}` : `Natur-Score ${r.score}%${k ? " · " + k : ""}`;
}

let vehicleForRouting: Vehicle = 45;
let routeModeForRouting: "fast" | "scenic" = "fast";

/* ───────────────────────── App ───────────────────────── */

export default function App() {
  const mapRef = useRef<MapView | null>(null);
  const creatorRef = useRef<MapView | null>(null);
  const regionRef = useRef<Region | null>(null);
  const navigatingRef = useRef(false);
  const followZoomRef = useRef({ latitudeDelta: 0.009, longitudeDelta: 0.009 });
  const headingRef = useRef(0);
  const speedRef = useRef(0);
  const lastTouchRef = useRef(0);
  const sheetY = useRef(new Animated.Value(0)).current;
  const sheetOpenRef = useRef(true);
  const sheetStartRef = useRef(0);
  const stepsRef = useRef<any[]>([]);
  const stepIndexRef = useRef(0);
  const coordsRef = useRef<Coord[]>([]);
  const progressRef = useRef(0);
  const arrivedRef = useRef(false);
  const poiCache = useRef<Record<string, Poi[]>>({});

  const [tab, setTab] = useState<Tab>("map");
  const [loggedIn, setLoggedIn] = useState(false);
  const [loginStep, setLoginStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");

  const [mapStyle, setMapStyle] = useState<MapStyle>("modern");
  const [vehicle, setVehicle] = useState<Vehicle>(45);
  const [routeMode, setRouteMode] = useState<"fast" | "scenic">("fast");
  const [followZoom, setFollowZoom] = useState({ latitudeDelta: 0.009, longitudeDelta: 0.009 });
  const [markerReady, setMarkerReady] = useState(false);

  const [location, setLocation] = useState<Coord | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [heading, setHeading] = useState(0);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [routing, setRouting] = useState(false);

  const [active, setActive] = useState<Active | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  const [seg, setSeg] = useState<"discover" | "mine">("discover");
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [found, setFound] = useState<PlannedRoute[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [stage, setStage] = useState("");
  const [saved, setSaved] = useState<PlannedRoute[]>([]);
  const [savedLoaded, setSavedLoaded] = useState(false);

  const [draftPts, setDraftPts] = useState<Coord[]>([]);
  const [draftRoute, setDraftRoute] = useState<{ coords: Coord[]; km: number; steps: any[] } | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftTags, setDraftTags] = useState<Kind[]>([]);
  const [draftLoop, setDraftLoop] = useState(false);

  // The standalone routing helper is outside App, so these refs expose the
  // current vehicle/mode without changing the existing route APIs.
  useEffect(() => {
    vehicleForRouting = vehicle;
    routeModeForRouting = routeMode;
  }, [vehicle, routeMode]);

  /* ── Refs aktuell halten ── */
  useEffect(() => {
    navigatingRef.current = navigating;
  }, [navigating]);
  useEffect(() => {
    followZoomRef.current = followZoom;
  }, [followZoom]);
  useEffect(() => {
    stepsRef.current = active?.steps ?? [];
    coordsRef.current = active?.coords ?? [];
  }, [active]);
  useEffect(() => {
    stepIndexRef.current = stepIndex;
  }, [stepIndex]);

  // Marker nach kurzer Zeit einfrieren -> spart Akku (Rotation läuft nativ weiter)
  useEffect(() => {
    if (!location || markerReady) return;
    const t = setTimeout(() => setMarkerReady(true), 700);
    return () => clearTimeout(t);
  }, [location, markerReady]);

  /* ── Gespeicherte Routen laden / speichern ── */
  useEffect(() => {
    (async () => {
      try {
        const raw = await Storage?.getItem(STORE_KEY);
        if (raw) setSaved(JSON.parse(raw));
      } catch {}
      setSavedLoaded(true);
    })();
  }, []);
  useEffect(() => {
    if (!savedLoaded) return;
    try {
      Promise.resolve(Storage?.setItem(STORE_KEY, JSON.stringify(saved))).catch(() => {});
    } catch {}
  }, [saved, savedLoaded]);

  /* ── Live-Standort + Kompass ── */
  useEffect(() => {
    let mounted = true;
    let posSub: Location.LocationSubscription | null = null;
    let headSub: Location.LocationSubscription | null = null;

    (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted" || !mounted) return;

      try {
        const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!mounted) return;
        const c = { latitude: first.coords.latitude, longitude: first.coords.longitude };
        setLocation(c);
        mapRef.current?.animateToRegion({ ...c, latitudeDelta: 0.045, longitudeDelta: 0.045 }, 500);
      } catch {}

      try {
        posSub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 3, timeInterval: 1000 },
          (position) => {
            const c = { latitude: position.coords.latitude, longitude: position.coords.longitude };
            setLocation(c);

            const speedMs =
              typeof position.coords.speed === "number" && position.coords.speed >= 0
                ? position.coords.speed
                : 0;
            speedRef.current = speedMs;
            setCurrentSpeed(speedMs * 3.6);

            // Beim Fahren ist die GPS-Fahrtrichtung genauer als der Kompass
            if (speedMs > 2.5 && typeof position.coords.heading === "number" && position.coords.heading >= 0) {
              headingRef.current = smoothAngle(headingRef.current, position.coords.heading);
              setHeading(headingRef.current);
            }

            if (navigatingRef.current) {
              // Fortschritt auf der Route (nur vorwärts suchen)
              const cs = coordsRef.current;
              if (cs.length) {
                let bi = progressRef.current;
                let bd = Infinity;
                const end = Math.min(cs.length, progressRef.current + 400);
                for (let i = progressRef.current; i < end; i++) {
                  const d = fastM(c, cs[i]);
                  if (d < bd) {
                    bd = d;
                    bi = i;
                  }
                }
                if (bd < 80 && bi !== progressRef.current) {
                  progressRef.current = bi;
                  setProgress(bi);
                }
              }

              // Abbiegehinweis weiterschalten, sobald die Kreuzung erreicht ist
              const st = stepsRef.current;
              const i = stepIndexRef.current;
              const nx = st[i + 1];
              if (nx?.maneuver?.location && i + 1 < st.length - 1) {
                const d = distM(c, { latitude: nx.maneuver.location[1], longitude: nx.maneuver.location[0] });
                if (d < 30) {
                  stepIndexRef.current = i + 1;
                  setStepIndex(i + 1);
                }
              }

              // Kamera folgt dir, außer du zoomst/verschiebst gerade (4 Sek. Pause)
              if (Date.now() - lastTouchRef.current > 4000) {
                mapRef.current?.animateToRegion({ ...c, ...followZoomRef.current }, 450);
              }
            }
          }
        );
      } catch {}

      try {
        headSub = await Location.watchHeadingAsync((h) => {
          if (speedRef.current > 2.5) return;
          const value = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
          if (value < 0) return;
          const diff = Math.abs(((value - headingRef.current + 540) % 360) - 180);
          if (diff < 2) return;
          const next = smoothAngle(headingRef.current, value);
          headingRef.current = next;
          setHeading(next);
        });
      } catch {}

      if (!mounted) {
        posSub?.remove();
        headSub?.remove();
      }
    })();

    return () => {
      mounted = false;
      posSub?.remove();
      headSub?.remove();
    };
  }, []);

  /* ── Routen-Ersteller: Strecke automatisch berechnen ── */
  useEffect(() => {
    if (draftPts.length < 2) {
      setDraftRoute(null);
      setDraftBusy(false);
      return;
    }
    let cancelled = false;
    setDraftBusy(true);
    const t = setTimeout(async () => {
      const pts = draftLoop ? [...draftPts, draftPts[0]] : draftPts;
      const r = await osrmRoute(pts);
      if (cancelled) return;
      setDraftBusy(false);
      setDraftRoute(r);
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [draftPts, draftLoop]);

  function setSheet(open: boolean) {
    sheetOpenRef.current = open;
    Animated.spring(sheetY, {
      toValue: open ? 0 : 118,
      useNativeDriver: true,
      speed: 18,
      bounciness: 3,
    }).start();
  }

  const sheetResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 7 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => {
      sheetStartRef.current = sheetOpenRef.current ? 0 : 118;
    },
    onPanResponderMove: (_, g) => {
      const v = clamp(sheetStartRef.current + g.dy, 0, 118);
      sheetY.setValue(v);
    },
    onPanResponderRelease: (_, g) => {
      const v = clamp(sheetStartRef.current + g.dy, 0, 118);
      setSheet(g.vy < -0.2 || (g.vy <= 0.2 && v < 59));
    },
  }), [sheetY]);

  /* ── Abgeleitete Werte ── */
  const cum = useMemo(() => {
    if (!active) return [] as number[];
    const arr = [0];
    for (let i = 1; i < active.coords.length; i++) {
      arr.push(arr[i - 1] + fastM(active.coords[i - 1], active.coords[i]));
    }
    return arr;
  }, [active]);

  const remainKm =
    active && navigating && cum.length
      ? Math.max(0, (cum[cum.length - 1] - cum[Math.min(progress, cum.length - 1)]) / 1000)
      : active
      ? active.km
      : 0;
  const etaMin = minutesFor(remainKm, vehicle);

  useEffect(() => {
    if (!navigating || !active || arrivedRef.current) return;
    if (progress > 3 && remainKm < 0.04) {
      arrivedRef.current = true;
      setNavigating(false);
      Alert.alert("Angekommen 🎉", "Du hast dein Ziel erreicht. Gute Fahrt weiterhin!");
    }
  }, [progress, remainKm, navigating, active]);

  /* ── Aktionen ── */
  function fitRoute(coords: Coord[]) {
    if (coords.length < 2) return;
    mapRef.current?.fitToCoordinates(coords, {
      edgePadding: { top: 170, right: 40, bottom: 330, left: 40 },
      animated: true,
    });
  }

  async function searchAddress() {
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    try {
      const response = await fetchTimeout(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=de&q=${encodeURIComponent(text)}`,
        { headers: { Accept: "application/json", "User-Agent": "MopedRide/1.0" } }
      );
      if (!response.ok) throw new Error("search");
      const data = await response.json();
      setResults(Array.isArray(data) ? data : []);
    } catch {
      Alert.alert("Adresssuche", "Die Adresse konnte gerade nicht geladen werden.");
    } finally {
      setSearching(false);
    }
  }

  async function calculateRoute(item: any) {
    const target = { latitude: Number(item.lat), longitude: Number(item.lon) };
    const start = location ?? { latitude: MUNICH.latitude, longitude: MUNICH.longitude };
    setResults([]);
    setRouting(true);
    Keyboard.dismiss();
    const r = await osrmRoute([start, target]);
    setRouting(false);
    if (!r) {
      Alert.alert("Route", "Für dieses Ziel konnte keine Route berechnet werden.");
      return;
    }
    setNavigating(false);
    setActive({
      name: String(item.display_name).split(",")[0],
      sub: item.display_name,
      coords: r.coords,
      km: r.km,
      steps: r.steps,
      stops: [],
      dest: target,
      color: C.primary,
    });
    setTimeout(() => fitRoute(r.coords), 250);
  }

  function beginNavigation(a: Active) {
    setActive(a);
    setTab("map");
    setStepIndex(0);
    stepIndexRef.current = 0;
    progressRef.current = 0;
    setProgress(0);
    arrivedRef.current = false;
    lastTouchRef.current = 0;
    stepsRef.current = a.steps;
    coordsRef.current = a.coords;
    setNavigating(true);
    setSheet(false);
    const z = { latitudeDelta: 0.009, longitudeDelta: 0.009 };
    setFollowZoom(z);
    followZoomRef.current = z;
    if (location) mapRef.current?.animateToRegion({ ...location, ...z }, 500);
    else fitRoute(a.coords);
  }

  function startNavigation() {
    if (!active || active.coords.length < 2) {
      Alert.alert("Ziel auswählen", "Bitte zuerst eine Adresse oder Route auswählen.");
      return;
    }
    beginNavigation(active);
  }

  function stopNavigation() {
    setNavigating(false);
    setSheet(true);
    setStepIndex(0);
    if (active) fitRoute(active.coords);
  }

  function clearRoute() {
    setActive(null);
    setNavigating(false);
    setStepIndex(0);
    setProgress(0);
  }

  function centerOnUser() {
    lastTouchRef.current = 0;
    if (!location) {
      Alert.alert("Standort", "Dein Standort ist noch nicht verfügbar. Erlaube den Standortzugriff für MopedRide.");
      return;
    }
    mapRef.current?.animateToRegion(
      {
        ...location,
        latitudeDelta: navigating ? 0.009 : 0.04,
        longitudeDelta: navigating ? 0.009 : 0.04,
      },
      500
    );
  }

  function zoomMap(factor: number) {
    const r = regionRef.current;
    if (!r) return;
    mapRef.current?.animateToRegion(
      {
        latitude: r.latitude,
        longitude: r.longitude,
        latitudeDelta: Math.min(80, Math.max(0.0008, r.latitudeDelta * factor)),
        longitudeDelta: Math.min(80, Math.max(0.0008, r.longitudeDelta * factor)),
      },
      250
    );
  }

  function openRoute(r: PlannedRoute, go = false) {
    const a: Active = {
      name: r.name,
      sub: subFor(r),
      coords: r.coords,
      km: r.km,
      steps: r.steps,
      stops: r.stops,
      color: r.custom ? C.purple : C.green,
    };
    if (go) {
      beginNavigation(a);
      return;
    }
    setNavigating(false);
    setActive(a);
    setTab("map");
    setTimeout(() => fitRoute(r.coords), 200);
  }

  function toggleSave(r: PlannedRoute) {
    setSaved((prev) =>
      prev.some((x) => x.id === r.id)
        ? prev.filter((x) => x.id !== r.id)
        : [{ ...r, coords: thin(r.coords, 600) }, ...prev]
    );
  }

  async function findScenicRoutes() {
    if (!location) {
      Alert.alert("Standort", "Ich brauche deinen Standort, um Routen in deiner Nähe zu finden. Bitte erlaube den Standortzugriff.");
      return;
    }
    setDiscovering(true);
    setStage("Wälder, Seen und Aussichten suchen …");
    try {
      const key = `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
      let pois = poiCache.current[key];
      if (!pois) {
        const loaded = await loadPois(location, SCENIC_RADIUS_KM * 1000);
        if (!loaded || loaded.length < 2) {
          Alert.alert("Naturdaten", "Die Karten-Daten konnten gerade nicht geladen werden. Versuch es in einer Minute nochmal.");
          return;
        }
        pois = loaded;
        poiCache.current[key] = loaded;
      }
      const cands = makeCandidates(location, pois, SCENIC_RADIUS_KM);
      if (!cands.length) {
        Alert.alert("Keine Strecken", "In deiner Nähe habe ich nicht genug schöne Orte gefunden.");
        return;
      }
      const list: PlannedRoute[] = [];
      for (let i = 0; i < cands.length; i++) {
        setStage(`Strecke ${i + 1} von ${cands.length} berechnen …`);
        const ch = cands[i];
        const pts = ch.b ? [location, ch.a.c, ch.b.c, location] : [location, ch.a.c, location];
        const r = await osrmRoute(pts);
        if (!r || r.coords.length < 5 || r.km < 3 || r.km > 45) continue;
        if (r.coords.some((c) => fastM(location, c) > 13000)) continue;
        const sc = scoreRoute(r.coords, pois);
        const used = ch.b ? [ch.a, ch.b] : [ch.a];
        const t = titleFor(used);
        list.push({
          id: `s${Date.now()}-${i}`,
          name: t.name,
          emoji: t.emoji,
          coords: r.coords,
          km: r.km,
          score: sc.score,
          kinds: sc.kinds,
          highlights: sc.highlights.length ? sc.highlights : used.map((p) => p.name),
          stops: used.map((p) => ({ c: p.c, kind: p.kind, name: p.name })),
          steps: r.steps,
          loop: true,
        });
      }
      list.sort((a, b) => b.score - a.score);
      setFound(list);
      if (!list.length) Alert.alert("Keine Strecken", "Ich konnte gerade keine Strecke berechnen. Versuch es gleich nochmal.");
    } catch {
      Alert.alert("Fehler", "Beim Suchen ist etwas schiefgelaufen. Prüfe dein Internet.");
    } finally {
      setDiscovering(false);
      setStage("");
    }
  }

  function goDiscover(k: Kind | "all") {
    setSeg("discover");
    setFilter(k);
    setTab("routes");
    if (!found.length && !discovering) findScenicRoutes();
  }

  function addDraftPoint(c: Coord) {
    setDraftPts((p) => (p.length >= 12 ? p : [...p, c]));
  }

  function startAtMyLocation() {
    if (!location) {
      Alert.alert("Standort", "Dein Standort ist noch nicht verfügbar.");
      return;
    }
    setDraftPts((p) => [location, ...p]);
    creatorRef.current?.animateToRegion({ ...location, latitudeDelta: 0.03, longitudeDelta: 0.03 }, 400);
  }

  function clearDraft() {
    setDraftPts([]);
    setDraftRoute(null);
    setDraftName("");
    setDraftTags([]);
    setDraftLoop(false);
  }

  function saveDraft() {
    if (!draftRoute || draftPts.length < 2) {
      Alert.alert("Route unvollständig", "Setze mindestens 2 Punkte auf der Karte.");
      return;
    }
    const name = draftName.trim() || `Meine Route ${saved.length + 1}`;
    const r: PlannedRoute = {
      id: `c${Date.now()}`,
      name,
      emoji: draftTags[0] ? KINDS[draftTags[0]].emoji : "🛵",
      coords: thin(draftRoute.coords, 600),
      km: draftRoute.km,
      score: 0,
      kinds: draftTags,
      highlights: [],
      stops: [],
      steps: draftRoute.steps,
      loop: draftLoop,
      custom: true,
    };
    setSaved((prev) => [r, ...prev]);
    clearDraft();
    Keyboard.dismiss();
    setSeg("mine");
    setTab("routes");
  }

  /* ── Wiederverwendbare UI-Teile ── */
  const displayedSpeed = Math.round(currentSpeed);
  const overLimit = displayedSpeed > vehicle + 3;

  const userMarker = location ? (
    <Marker
      coordinate={location}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={heading}
      tracksViewChanges={!markerReady}
      zIndex={10}
    >
      <View style={styles.userMarker}>
        <View style={styles.userCone} />
        <View style={styles.userDot}>
          <View style={styles.userDotArrow} />
        </View>
      </View>
    </Marker>
  ) : null;

  function baseMap(ref: any, props: any, children: React.ReactNode) {
    const tiled = mapStyle === "modern" || mapStyle === "dark";
    const nativeType = tiled ? (Platform.OS === "android" ? "none" : "standard") : mapStyle;
    return (
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        mapType={nativeType as any}
        showsCompass={false}
        rotateEnabled
        pitchEnabled
        zoomEnabled
        scrollEnabled
        zoomTapEnabled
        zoomControlEnabled={false}
        toolbarEnabled={false}
        showsMyLocationButton={false}
        minZoomLevel={2}
        maxZoomLevel={20}
        {...props}
      >
        {tiled && (
          <UrlTile
            urlTemplate={TILES[mapStyle]}
            maximumZ={19}
            tileSize={256}
            zIndex={-1}
            {...({ shouldReplaceMapContent: true } as any)}
          />
        )}
        {children}
      </MapView>
    );
  }

  function vehicleToggle() {
    return (
      <View style={styles.vToggle}>
        {([25, 45] as Vehicle[]).map((v) => (
          <Pressable
            key={v}
            onPress={() => setVehicle(v)}
            style={[styles.vOpt, vehicle === v && styles.vOptOn]}
          >
            <Text style={[styles.vText, vehicle === v && styles.vTextOn]}>
              {v === 25 ? "Mofa" : "Moped"} {v}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }

  /* ───────────── Tab: Karte ───────────── */
  function renderMap() {
    const markTouch = () => {
      lastTouchRef.current = Date.now();
    };
    const casing = mapStyle === "dark" || mapStyle === "satellite" || mapStyle === "hybrid" ? "#0B1220" : "#FFFFFF";

    const up = active ? active.steps[Math.min(stepIndex + 1, active.steps.length - 1)] : null;
    const desc = describeStep(up);
    const meters =
      up?.maneuver?.location && location
        ? Math.round(distM(location, { latitude: up.maneuver.location[1], longitude: up.maneuver.location[0] }))
        : null;
    const metersText = meters == null ? "—" : meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;

    return (
      <View style={styles.flex} onTouchStart={markTouch} onTouchMove={markTouch} onTouchEnd={markTouch}>
        {baseMap(
          mapRef,
          {
            initialRegion: location
              ? { ...location, latitudeDelta: 0.045, longitudeDelta: 0.045 }
              : MUNICH,
            onPanDrag: markTouch,
            onTouchStart: markTouch,
            onRegionChangeComplete: (region: Region) => {
              regionRef.current = region;
              if (navigating) {
                setFollowZoom({
                  latitudeDelta: Math.max(0.0008, Math.min(2, region.latitudeDelta)),
                  longitudeDelta: Math.max(0.0008, Math.min(2, region.longitudeDelta)),
                });
              }
            },
          },
          <>
            {active && active.coords.length > 1 && (
              <Polyline coordinates={active.coords} strokeColor={casing} strokeWidth={10} lineCap="round" lineJoin="round" />
            )}
            {active && active.coords.length > 1 && (
              <Polyline coordinates={active.coords} strokeColor={active.color} strokeWidth={6} lineCap="round" lineJoin="round" />
            )}
            {active?.stops.map((s, i) => (
              <Marker key={`st${i}`} coordinate={s.c} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={[styles.stopDot, { backgroundColor: KINDS[s.kind].color }]}>
                  <AppIcon name={KINDS[s.kind].icon} size={14} color="#fff" />
                </View>
              </Marker>
            ))}
            {active?.dest && (
              <Marker coordinate={active.dest} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={styles.destPin}>
                  <AppIcon name="flag" size={14} color="#fff" />
                </View>
              </Marker>
            )}
            {userMarker}
          </>
        )}

        <SafeAreaView style={styles.mapOverlay} pointerEvents="box-none">
          <View pointerEvents="box-none">
            {!navigating ? (
              <>
                <View style={styles.searchBar}>
                  <AppIcon name="search" size={20} color={C.sub} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    onSubmitEditing={searchAddress}
                    placeholder="Wohin möchtest du fahren?"
                    placeholderTextColor="#8A929E"
                    style={styles.searchInput}
                    returnKeyType="search"
                  />
                  {query.length > 0 && (
                    <Pressable
                      onPress={() => {
                        setQuery("");
                        setResults([]);
                      }}
                      hitSlop={8}
                    >
                      <AppIcon name="close-circle" size={20} color="#B6BDC8" />
                    </Pressable>
                  )}
                  <Pressable onPress={searchAddress} style={styles.searchAction}>
                    {searching ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <AppIcon name="arrow-forward" size={18} color="#fff" />
                    )}
                  </Pressable>
                </View>

                {results.length > 0 ? (
                  <View style={styles.resultsCard}>
                    {results.map((item, index) => (
                      <Pressable
                        key={`${item.place_id}-${index}`}
                        onPress={() => calculateRoute(item)}
                        style={styles.resultRow}
                      >
                        <View style={styles.resultIcon}>
                          <AppIcon name="location" size={18} color={C.primary} />
                        </View>
                        <View style={styles.flex}>
                          <Text style={styles.resultTitle} numberOfLines={1}>
                            {item.display_name?.split(",")[0]}
                          </Text>
                          <Text style={styles.resultSub} numberOfLines={2}>
                            {item.display_name}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipScroll}
                    contentContainerStyle={styles.chipRow}
                    keyboardShouldPersistTaps="handled"
                  >
                    {KIND_LIST.map((k) => (
                      <Pressable key={k} onPress={() => goDiscover(k)} style={styles.quickChip}>
                        <AppIcon name={KINDS[k].icon} size={15} color={KINDS[k].color} />
                        <Text style={styles.quickChipText}>{KINDS[k].label}-Routen</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
              </>
            ) : (
              <View style={styles.navTop}>
                <View style={styles.navTurnIcon}>
                  <Text style={styles.navTurnArrow}>{desc.arrow}</Text>
                </View>
                <View style={styles.navDirection}>
                  <Text style={styles.navMeters}>{metersText}</Text>
                  <Text style={styles.navTurnText} numberOfLines={2}>
                    {desc.text}
                  </Text>
                </View>
                <Pressable onPress={stopNavigation} style={styles.stopButton}>
                  <Text style={styles.stopText}>Beenden</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.mapButtons} pointerEvents="box-none">
              <Pressable
                onPress={() => setMapStyle(STYLE_ORDER[(STYLE_ORDER.indexOf(mapStyle) + 1) % STYLE_ORDER.length])}
                style={styles.mapButton}
              >
                <AppIcon name="layers" size={20} color={C.ink} />
                <Text style={styles.mapButtonLabel}>{STYLE_LABEL[mapStyle]}</Text>
              </Pressable>

              <Pressable onPress={centerOnUser} style={styles.mapButton}>
                <AppIcon name="locate" size={22} color={C.primary} />
              </Pressable>
            </View>
          </View>

          {!navigating && (
            <Animated.View {...sheetResponder.panHandlers} style={[styles.sheet, { transform: [{ translateY: sheetY }] }]}>
              <View style={styles.handle} />
              <View style={styles.sheetHead}>
                <View>
                  <Text style={styles.eyebrow}>MOPEDRIDE</Text>
                  <Text style={styles.sheetTitle}>{active ? "Deine Route" : "Fahrt planen"}</Text>
                </View>
                {vehicleToggle()}
              </View>

              <View style={styles.routeModeSwitch}>
                <Pressable onPress={() => setRouteMode("fast")} style={[styles.routeModeOpt, routeMode === "fast" && styles.routeModeOptOn]}>
                  <Text style={[styles.routeModeText, routeMode === "fast" && styles.routeModeTextOn]}>⚡ Schnellste</Text>
                </Pressable>
                <Pressable onPress={() => setRouteMode("scenic")} style={[styles.routeModeOpt, routeMode === "scenic" && styles.routeModeOptOn]}>
                  <Text style={[styles.routeModeText, routeMode === "scenic" && styles.routeModeTextOn]}>🌲 Ausflug</Text>
                </Pressable>
              </View>

              {active ? (
                <View style={styles.routeCard}>
                  <View style={styles.routeTop}>
                    <View style={[styles.routeBadge, { backgroundColor: active.color + "22" }]}>
                      <AppIcon name={active.dest ? "location" : "leaf"} size={20} color={active.color} />
                    </View>
                    <View style={styles.flex}>
                      <Text style={styles.routeTitle} numberOfLines={1}>
                        {active.name}
                      </Text>
                      <Text style={styles.routeSub} numberOfLines={1}>
                        {active.sub}
                      </Text>
                    </View>
                    <Pressable onPress={clearRoute} hitSlop={10}>
                      <AppIcon name="close" size={24} color="#98A2B3" />
                    </Pressable>
                  </View>
                  <View style={styles.routeStats}>
                    <View style={styles.pill}>
                      <AppIcon name="trail-sign-outline" size={14} color={C.sub} />
                      <Text style={styles.pillText}>{active.km.toFixed(1)} km</Text>
                    </View>
                    <View style={styles.pill}>
                      <AppIcon name="time-outline" size={14} color={C.sub} />
                      <Text style={styles.pillText}>{fmtMin(minutesFor(active.km, vehicle))}</Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={startNavigation}
                    disabled={routing}
                    style={[styles.goButton, { backgroundColor: active.color }]}
                  >
                    {routing ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <>
                        <AppIcon name="navigate" size={18} color="#fff" />
                        <Text style={styles.goButtonText}>Navigation starten</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              ) : (
                <View style={styles.hintCard}>
                  <Text style={styles.hintTitle}>Wohin geht's?</Text>
                  <Text style={styles.hintText}>
                    Such oben eine Adresse – oder lass dir schöne Strecken durch Wald, entlang von Seen und zu
                    Aussichtspunkten in 12 km Umkreis zeigen.
                  </Text>
                  <Pressable onPress={() => goDiscover("all")} style={styles.hintButton}>
                    <AppIcon name="compass" size={18} color="#fff" />
                    <Text style={styles.hintButtonText}>Schöne Routen entdecken</Text>
                  </Pressable>
                </View>
              )}
            </Animated.View>
          )}

          {navigating && (
            <View style={styles.navBottom}>
              <View style={[styles.speedCircle, overLimit && styles.speedOver]}>
                <Text style={[styles.speedVal, overLimit && styles.speedValOver]}>{displayedSpeed}</Text>
                <Text style={[styles.speedUnit, overLimit && styles.speedValOver]}>km/h</Text>
              </View>
              <View style={styles.navStat}>
                <Text style={styles.navBig}>{fmtMin(etaMin)}</Text>
                <Text style={styles.navSmall}>Restzeit</Text>
              </View>
              <View style={styles.navLine} />
              <View style={styles.navStat}>
                <Text style={styles.navBig}>{remainKm.toFixed(1)} km</Text>
                <Text style={styles.navSmall}>Reststrecke</Text>
              </View>
              <View style={styles.navLine} />
              <View style={styles.navStat}>
                <Text style={styles.navBig}>{clock(etaMin)}</Text>
                <Text style={styles.navSmall}>Ankunft</Text>
              </View>
            </View>
          )}
        </SafeAreaView>
      </View>
    );
  }

  /* ───────────── Tab: Routen ───────────── */
  function renderRouteCard(r: PlannedRoute) {
    const isSaved = saved.some((x) => x.id === r.id);
    const tint = r.custom ? C.purple : C.green;
    return (
      <View key={r.id} style={styles.rCard}>
        <View style={styles.rTop}>
          <RouteThumb coords={r.coords} color={tint} />
          <View style={styles.flex}>
            <Text style={styles.rTitle} numberOfLines={2}>
              {r.emoji} {r.name}
            </Text>
            <Text style={styles.rMeta}>
              {r.km.toFixed(1)} km · {fmtMin(minutesFor(r.km, vehicle))} · {r.loop ? "Rundtour" : "Strecke"}
            </Text>
            {!r.custom && (
              <View style={styles.scoreRow}>
                <View style={styles.scoreTrack}>
                  <View
                    style={[styles.scoreFill, { width: `${r.score}%`, backgroundColor: scoreColor(r.score) }]}
                  />
                </View>
                <Text style={[styles.scoreText, { color: scoreColor(r.score) }]}>{r.score}%</Text>
              </View>
            )}
          </View>
        </View>

        {r.kinds.length > 0 && (
          <View style={styles.tagRow}>
            {r.kinds.map((k) => (
              <View key={k} style={[styles.tag, { backgroundColor: KINDS[k].bg }]}>
                <AppIcon name={KINDS[k].icon} size={12} color={KINDS[k].color} />
                <Text style={[styles.tagText, { color: KINDS[k].color }]}>{KINDS[k].label}</Text>
              </View>
            ))}
          </View>
        )}
        {r.highlights.length > 0 && (
          <Text style={styles.rHighlights} numberOfLines={2}>
            Vorbei an: {r.highlights.join(" · ")}
          </Text>
        )}

        <View style={styles.rActions}>
          <Pressable onPress={() => toggleSave(r)} style={styles.iconBtn}>
            <AppIcon name={isSaved ? "heart" : "heart-outline"} size={20} color={isSaved ? "#F04438" : C.sub} />
          </Pressable>
          <Pressable onPress={() => openRoute(r)} style={styles.ghostBtn}>
            <Text style={styles.ghostText}>Auf Karte</Text>
          </Pressable>
          <Pressable onPress={() => openRoute(r, true)} style={[styles.goBtn, { backgroundColor: tint }]}>
            <AppIcon name="navigate" size={16} color="#fff" />
            <Text style={styles.goText}>Los</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  function renderRoutes() {
    const list = seg === "discover" ? found.filter((r) => filter === "all" || r.kinds.includes(filter)) : saved;
    return (
      <ScrollView style={styles.pageBg} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>ENTDECKEN</Text>
        <Text style={styles.pageTitle}>Routen</Text>
        <Text style={styles.pageSub}>Schöne Strecken im Umkreis von {SCENIC_RADIUS_KM} km – Wald, Seen und Aussichten.</Text>

        <View style={styles.segment}>
          <Pressable onPress={() => setSeg("discover")} style={[styles.segOpt, seg === "discover" && styles.segOn]}>
            <Text style={[styles.segText, seg === "discover" && styles.segTextOn]}>Entdecken</Text>
          </Pressable>
          <Pressable onPress={() => setSeg("mine")} style={[styles.segOpt, seg === "mine" && styles.segOn]}>
            <Text style={[styles.segText, seg === "mine" && styles.segTextOn]}>Meine Routen ({saved.length})</Text>
          </Pressable>
        </View>

        {seg === "discover" ? (
          <>
            <View style={styles.hero}>
              <View style={styles.heroGlowA} />
              <View style={styles.heroGlowB} />
              <Text style={styles.heroEyebrow}>NATUR-ROUTEN</Text>
              <Text style={styles.heroTitle}>Fahr dahin, wo es schön ist</Text>
              <Text style={styles.heroText}>
                Ich suche Wälder, Seen, Parks und Aussichtspunkte um dich herum und baue daraus Rundtouren – ohne
                Autobahn, mit {vehicle} km/h gerechnet.
              </Text>
              {vehicleToggle()}
              <Pressable onPress={findScenicRoutes} disabled={discovering} style={styles.heroBtn}>
                {discovering ? (
                  <ActivityIndicator color="#0B1F3A" />
                ) : (
                  <>
                    <AppIcon name="compass" size={18} color="#0B1F3A" />
                    <Text style={styles.heroBtnText}>{found.length ? "Neu suchen" : "Schöne Routen finden"}</Text>
                  </>
                )}
              </Pressable>
              {discovering && <Text style={styles.heroStage}>{stage}</Text>}
            </View>

            {found.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.filterScroll}
                contentContainerStyle={styles.chipRow}
              >
                <Pressable onPress={() => setFilter("all")} style={[styles.fChip, filter === "all" && styles.fChipOn]}>
                  <Text style={[styles.fChipText, filter === "all" && styles.fChipTextOn]}>Alle</Text>
                </Pressable>
                {KIND_LIST.map((k) => (
                  <Pressable key={k} onPress={() => setFilter(k)} style={[styles.fChip, filter === k && styles.fChipOn]}>
                    <AppIcon name={KINDS[k].icon} size={14} color={filter === k ? "#fff" : KINDS[k].color} />
                    <Text style={[styles.fChipText, filter === k && styles.fChipTextOn]}>{KINDS[k].label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {list.map(renderRouteCard)}

            {found.length > 0 && list.length === 0 && (
              <Text style={styles.emptyText}>Für diesen Filter ist keine Strecke dabei. Probier „Alle“.</Text>
            )}
            {!found.length && !discovering && (
              <Text style={styles.emptyText}>Tippe oben auf „Schöne Routen finden“. Die Suche dauert etwa 10–20 Sekunden.</Text>
            )}
          </>
        ) : (
          <>
            {saved.map(renderRouteCard)}
            {!saved.length && (
              <View style={styles.emptyCard}>
                <AppIcon name="bookmark-outline" size={32} color={C.primary} />
                <Text style={styles.emptyTitle}>Noch keine Routen gespeichert</Text>
                <Text style={styles.emptyText}>
                  Speichere Vorschläge mit dem Herz – oder zeichne deine eigene Lieblingsstrecke mit dem Plus.
                </Text>
                <Pressable onPress={() => setTab("add")} style={styles.hintButton}>
                  <AppIcon name="add" size={20} color="#fff" />
                  <Text style={styles.hintButtonText}>Route erstellen</Text>
                </Pressable>
              </View>
            )}
          </>
        )}
      </ScrollView>
    );
  }

  /* ───────────── Tab: Plus (Route zeichnen) ───────────── */
  function renderCreator() {
    const hasRoute = !!draftRoute && draftPts.length >= 2;
    const start = draftPts[0] ?? location;
    const initial = start ? { ...start, latitudeDelta: 0.05, longitudeDelta: 0.05 } : MUNICH;
    const casing = mapStyle === "dark" || mapStyle === "satellite" || mapStyle === "hybrid" ? "#0B1220" : "#FFFFFF";

    return (
      <View style={styles.flex}>
        {baseMap(
          creatorRef,
          { initialRegion: initial, onPress: (e: any) => addDraftPoint(e.nativeEvent.coordinate) },
          <>
            {hasRoute && (
              <Polyline coordinates={draftRoute!.coords} strokeColor={casing} strokeWidth={10} lineCap="round" lineJoin="round" />
            )}
            {hasRoute && (
              <Polyline coordinates={draftRoute!.coords} strokeColor={C.purple} strokeWidth={6} lineCap="round" lineJoin="round" />
            )}
            {draftPts.map((p, i) => (
              <Marker key={`d${i}-${draftPts.length}`} coordinate={p} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={[styles.wpDot, i === 0 && styles.wpStart]}>
                  <Text style={styles.wpText}>{i === 0 ? "S" : i + 1}</Text>
                </View>
              </Marker>
            ))}
            {userMarker}
          </>
        )}

        <SafeAreaView style={styles.mapOverlay} pointerEvents="box-none">
          <View style={styles.creatorTop}>
            <Text style={styles.eyebrow}>NEUE ROUTE</Text>
            <Text style={styles.creatorTitle}>Route zeichnen</Text>
            <Text style={styles.creatorHint}>
              Tippe auf die Karte, um Punkte zu setzen. Ich lege die Strecke automatisch auf passende Straßen.
            </Text>
            <Pressable onPress={startAtMyLocation} style={styles.miniBtn}>
              <AppIcon name="locate" size={14} color={C.primary} />
              <Text style={styles.miniBtnText}>Start = mein Standort</Text>
            </Pressable>
          </View>

          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} pointerEvents="box-none">
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.statRow}>
                <View style={styles.statBox}>
                  <Text style={styles.statBoxVal}>{hasRoute ? `${draftRoute!.km.toFixed(1)} km` : "–"}</Text>
                  <Text style={styles.statBoxLabel}>Strecke</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statBoxVal}>{hasRoute ? fmtMin(minutesFor(draftRoute!.km, vehicle)) : "–"}</Text>
                  <Text style={styles.statBoxLabel}>Fahrzeit ({vehicle})</Text>
                </View>
                <View style={styles.statBox}>
                  {draftBusy ? (
                    <ActivityIndicator color={C.purple} />
                  ) : (
                    <Text style={styles.statBoxVal}>{draftPts.length}</Text>
                  )}
                  <Text style={styles.statBoxLabel}>Punkte</Text>
                </View>
              </View>

              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                placeholder="Name der Route (z. B. Feierabend am See)"
                placeholderTextColor="#98A2B3"
                style={styles.nameInput}
                returnKeyType="done"
              />

              <View style={styles.tagRow}>
                {KIND_LIST.map((k) => {
                  const on = draftTags.includes(k);
                  return (
                    <Pressable
                      key={k}
                      onPress={() => setDraftTags((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]))}
                      style={[styles.tag, { backgroundColor: on ? KINDS[k].color : KINDS[k].bg }]}
                    >
                      <AppIcon name={KINDS[k].icon} size={12} color={on ? "#fff" : KINDS[k].color} />
                      <Text style={[styles.tagText, { color: on ? "#fff" : KINDS[k].color }]}>{KINDS[k].label}</Text>
                    </Pressable>
                  );
                })}
                <Pressable
                  onPress={() => setDraftLoop((v) => !v)}
                  style={[styles.tag, { backgroundColor: draftLoop ? C.purple : "#F0EDFF" }]}
                >
                  <AppIcon name="repeat" size={12} color={draftLoop ? "#fff" : C.purple} />
                  <Text style={[styles.tagText, { color: draftLoop ? "#fff" : C.purple }]}>Rundtour</Text>
                </Pressable>
              </View>

              <View style={styles.btnRow}>
                <Pressable onPress={() => setDraftPts((p) => p.slice(0, -1))} style={styles.iconBtn}>
                  <AppIcon name="arrow-undo" size={20} color={C.ink} />
                </Pressable>
                <Pressable onPress={clearDraft} style={styles.iconBtn}>
                  <AppIcon name="trash-outline" size={20} color="#F04438" />
                </Pressable>
                <Pressable onPress={saveDraft} style={[styles.goButton, styles.saveBtn]}>
                  <AppIcon name="checkmark" size={20} color="#fff" />
                  <Text style={styles.goButtonText}>Route speichern</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    );
  }

  /* ───────────── Weitere Seiten ───────────── */
  function renderPage() {
    if (tab === "routes") return renderRoutes();
    if (tab === "add") return renderCreator();

    if (tab === "friends") {
      return (
        <Page title="Freunde" eyebrow="COMMUNITY">
          <Card
            icon="people"
            title="MopedRide Freunde"
            text="Finde Freunde über ihre MopedRide-ID, verwalte Anfragen und teile Fahrten."
          />
          <View style={styles.idCard}>
            <Text style={styles.idLabel}>DEINE MOPEDRIDE-ID</Text>
            <Text style={styles.idValue}>MR-482917</Text>
            <Text style={styles.idHint}>Nur diese ID musst du anderen geben.</Text>
          </View>
        </Page>
      );
    }

    return (
      <Page title="Profil" eyebrow="DEIN MOPEDRIDE">
        <View style={styles.profileHero}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>K</Text>
          </View>
          <View style={styles.profileHeroInfo}>
            <Text style={styles.profileName}>Kai</Text>
            <Text style={styles.profileHandle}>@kai</Text>
            <View style={styles.profileIdPill}>
              <Text style={styles.profileIdPillText}>MR-482917</Text>
            </View>
          </View>
          <Pressable
            onPress={() => Alert.alert("Profil", "Profil bearbeiten kommt als nächstes.")}
            style={styles.editButton}
          >
            <Text style={styles.editButtonText}>Bearbeiten</Text>
          </Pressable>
        </View>

        <View style={styles.profileStats}>
          <Stat value="0" label="Freunde" />
          <Stat value={`${saved.length}`} label="Routen" />
          <Stat value={`${vehicle}`} label="km/h" />
        </View>

        <View style={styles.settingCard}>
          <Text style={styles.settingTitle}>Mein Fahrzeug</Text>
          {vehicleToggle()}
          <Text style={[styles.settingSub, { marginTop: 10 }]}>
            Fahrzeiten werden mit etwa 85 % deiner Höchstgeschwindigkeit gerechnet. Autobahnen werden gemieden.
          </Text>
        </View>

        <View style={styles.settingCard}>
          <Text style={styles.settingTitle}>Privatsphäre</Text>
          <View style={styles.privacyRow}>
            <View style={styles.privacyDot} />
            <Text style={styles.settingMain}>Standort nicht öffentlich</Text>
          </View>
          <Text style={styles.settingSub}>Dein genauer Standort wird nicht als Profilinformation angezeigt.</Text>
        </View>

        <View style={styles.settingCard}>
          <Text style={styles.settingTitle}>Datenquellen</Text>
          <Text style={styles.settingSub}>
            Karte © OpenStreetMap-Mitwirkende, © CARTO · Routing: OSRM · Wälder, Seen & Aussichten: OpenStreetMap
            (Overpass API).
          </Text>
        </View>
      </Page>
    );
  }

  /* ───────────── Login ───────────── */
  if (!loggedIn) {
    return (
      <View style={styles.loginScreen}>
        <StatusBar barStyle="dark-content" />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
        >
          <ScrollView
            contentContainerStyle={styles.loginScrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            showsVerticalScrollIndicator={false}
          >
            <SafeAreaView style={styles.loginSafe}>
              <View style={styles.loginBrand}>
                <View style={styles.loginLogo}>
                  <Text style={styles.loginLogoText}>M</Text>
                </View>
                <Text style={styles.loginBrandName}>MopedRide</Text>
                <Text style={styles.loginBrandSub}>Dein Netzwerk für Mofa & Moped</Text>
              </View>

              <View style={styles.loginCard}>
                {loginStep === "phone" ? (
                  <>
                    <Text style={styles.loginTitle}>Willkommen 👋</Text>
                    <Text style={styles.loginText}>
                      Melde dich mit deiner Handynummer an. Wir schicken dir einen SMS-Code zur Bestätigung.
                    </Text>

                    <Text style={styles.inputLabel}>Handynummer</Text>
                    <View style={styles.phoneInput}>
                      <Text style={styles.countryPrefix}>🇩🇪 +49</Text>
                      <TextInput
                        value={phone}
                        onChangeText={setPhone}
                        keyboardType="phone-pad"
                        placeholder="151 12345678"
                        placeholderTextColor="#9299A3"
                        style={styles.loginInput}
                      />
                    </View>

                    <Pressable
                      onPress={() => {
                        Keyboard.dismiss();
                        const digits = phone.replace(/\D/g, "");
                        if (digits.length < 7) {
                          Alert.alert("Handynummer", "Bitte gib eine gültige Handynummer ein.");
                          return;
                        }
                        setLoginStep("code");
                      }}
                      style={styles.loginPrimary}
                    >
                      <Text style={styles.loginPrimaryText}>SMS-Code anfordern</Text>
                    </Pressable>

                    <Text style={styles.loginLegal}>
                      Mit der Anmeldung stimmst du den Nutzungs- und Datenschutzregeln von MopedRide zu.
                    </Text>
                  </>
                ) : (
                  <>
                    <Pressable onPress={() => setLoginStep("phone")} style={styles.backLogin}>
                      <Text style={styles.backLoginText}>‹ Nummer ändern</Text>
                    </Pressable>

                    <Text style={styles.loginTitle}>Code eingeben</Text>
                    <Text style={styles.loginText}>
                      Gib den 6-stelligen Code ein, den wir an <Text style={styles.loginBold}>{phone}</Text> gesendet
                      haben.
                    </Text>

                    <TextInput
                      value={otp}
                      onChangeText={(value) => setOtp(value.replace(/\D/g, "").slice(0, 6))}
                      keyboardType="number-pad"
                      placeholder="000000"
                      placeholderTextColor="#A0A6AF"
                      maxLength={6}
                      style={styles.otpInput}
                    />

                    <Pressable
                      onPress={() => {
                        Keyboard.dismiss();
                        if (otp.length !== 6) {
                          Alert.alert("SMS-Code", "Bitte gib den 6-stelligen Code ein.");
                          return;
                        }
                        Alert.alert(
                          "SMS-Login",
                          "Die Login-Oberfläche ist bereit. Für echte SMS-Verifizierung wird als nächstes der Auth-Server verbunden.",
                          [{ text: "Weiter", onPress: () => setLoggedIn(true) }]
                        );
                      }}
                      style={styles.loginPrimary}
                    >
                      <Text style={styles.loginPrimaryText}>Anmelden</Text>
                    </Pressable>

                    <Pressable onPress={() => setOtp("")} style={styles.resendButton}>
                      <Text style={styles.resendText}>Code erneut senden</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </SafeAreaView>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  /* ───────────── Hauptlayout ───────────── */
  return (
    <View style={styles.app}>
      <StatusBar barStyle={mapStyle === "dark" && tab === "map" ? "light-content" : "dark-content"} />
      <View style={styles.flex}>
        {renderMap()}
        {tab !== "map" && <View style={StyleSheet.absoluteFill}>{renderPage()}</View>}
      </View>

      <Animated.View style={[styles.bottomSafe, { transform: [{ translateY: sheetY }] }]} pointerEvents="box-none">
        <SafeAreaView>
        <View style={styles.bottomNav}>
          <NavButton icon="map" off="map-outline" label="Karte" active={tab === "map"} onPress={() => setTab("map")} />
          <NavButton
            icon="trail-sign"
            off="trail-sign-outline"
            label="Routen"
            active={tab === "routes"}
            onPress={() => setTab("routes")}
          />
          <Pressable onPress={() => setTab("add")} style={[styles.plusBtn, tab === "add" && styles.plusBtnActive]}>
            <AppIcon name="add" size={30} color="#fff" />
          </Pressable>
          <NavButton
            icon="people"
            off="people-outline"
            label="Freunde"
            active={tab === "friends"}
            onPress={() => setTab("friends")}
          />
          <NavButton
            icon="person"
            off="person-outline"
            label="Profil"
            active={tab === "profile"}
            onPress={() => setTab("profile")}
          />
        </View>
        </SafeAreaView>
      </Animated.View>
    </View>
  );
}

/* ───────────────────────── Kleine Komponenten ───────────────────────── */

// Mini-Vorschau der Strecke (Punktlinie, ohne Zusatz-Bibliothek)
function RouteThumb({ coords, color }: { coords: Coord[]; color: string }) {
  const W = 84;
  const H = 84;
  const P = 10;
  const pts = thin(coords, 26);
  const lats = pts.map((p) => p.latitude);
  const lons = pts.map((p) => p.longitude);
  const minLa = Math.min(...lats);
  const maxLa = Math.max(...lats);
  const minLo = Math.min(...lons);
  const maxLo = Math.max(...lons);
  const kx = Math.cos(toRad((minLa + maxLa) / 2));
  const spanX = Math.max((maxLo - minLo) * kx, 1e-6);
  const spanY = Math.max(maxLa - minLa, 1e-6);
  const s = Math.min((W - 2 * P) / spanX, (H - 2 * P) / spanY);
  const ox = (W - spanX * s) / 2;
  const oy = (H - spanY * s) / 2;
  return (
    <View style={[styles.thumb, { width: W, height: H }]}>
      {pts.map((p, i) => {
        const x = ox + (p.longitude - minLo) * kx * s;
        const y = oy + (maxLa - p.latitude) * s;
        const size = i === 0 ? 9 : 5;
        return (
          <View
            key={i}
            style={{
              position: "absolute",
              left: x - size / 2,
              top: y - size / 2,
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: i === 0 ? "#101828" : color,
            }}
          />
        );
      })}
    </View>
  );
}

function AppIcon({ name, size = 20, color = C.ink }: { name: IconName; size?: number; color?: string }) {
  const glyphs: Record<string, string> = {
    add: "+",
    "arrow-forward": "→",
    "arrow-undo": "↶",
    "bookmark-outline": "🔖",
    checkmark: "✓",
    close: "×",
    "close-circle": "⊗",
    compass: "◉",
    eye: "◉",
    flag: "⚑",
    flower: "✿",
    heart: "♥",
    "heart-outline": "♡",
    layers: "▱",
    leaf: "🍃",
    locate: "⌾",
    location: "●",
    navigate: "➤",
    repeat: "↻",
    search: "⌕",
    "time-outline": "◷",
    "trail-sign-outline": "⚑",
    trash: "⌫",
    "trash-outline": "⌫",
    water: "≈",
    "person": "●",
    "people": "●●",
    "map": "▣",
    "map-outline": "▣",
    "person-outline": "○",
    "people-outline": "○○",
    "trail-sign": "⚑",
    "add-circle": "+",
    "close-outline": "×",
    "location-outline": "○",
    "leaf-outline": "🍃",
  };
  return (
    <Text
      style={{
        color,
        fontSize: size,
        lineHeight: size + 3,
        fontWeight: "800",
        textAlign: "center",
      }}
    >
      {glyphs[name] ?? "•"}
    </Text>
  );
}

function Page({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <ScrollView style={styles.pageBg} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.pageTitle}>{title}</Text>
      {children}
    </ScrollView>
  );
}

function Card({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <View style={styles.genericCard}>
      <View style={styles.genericIcon}>
        <AppIcon name={icon} size={26} color={C.primary} />
      </View>
      <Text style={styles.genericTitle}>{title}</Text>
      <Text style={styles.genericText}>{text}</Text>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function NavButton({
  icon,
  off,
  label,
  active,
  onPress,
}: {
  icon: IconName;
  off: IconName;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.navItem}>
      <AppIcon name={active ? icon : off} size={23} color={active ? C.primary : "#98A2B3"} />
      <Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
    </Pressable>
  );
}

/* ───────────────────────── Styles ───────────────────────── */

const shadow = {
  shadowColor: "#0B1220",
  shadowOpacity: 0.12,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 5 },
  elevation: 8,
} as const;

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },

  /* Login */
  loginScreen: { flex: 1, backgroundColor: C.bg },
  loginScrollContent: { flexGrow: 1 },
  loginSafe: { flex: 1, justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 80, paddingBottom: 30 },
  loginBrand: { alignItems: "center" },
  loginLogo: { width: 66, height: 66, borderRadius: 21, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", shadowColor: C.primary, shadowOpacity: 0.25, shadowRadius: 16, elevation: 7 },
  loginLogoText: { color: "#FFF", fontSize: 34, fontWeight: "900" },
  loginBrandName: { marginTop: 13, fontSize: 30, fontWeight: "900", color: "#11161D" },
  loginBrandSub: { marginTop: 4, color: "#747C87", fontSize: 13 },
  loginCard: { backgroundColor: "#FFF", borderRadius: 25, padding: 20, ...shadow },
  loginTitle: { fontSize: 24, fontWeight: "900", color: "#11161D" },
  loginText: { color: "#727A85", fontSize: 13, lineHeight: 19, marginTop: 7 },
  inputLabel: { marginTop: 20, fontSize: 11, fontWeight: "900", color: "#424A54" },
  phoneInput: { minHeight: 53, marginTop: 7, borderWidth: 1, borderColor: "#E0E4E9", borderRadius: 14, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 },
  countryPrefix: { fontWeight: "800", color: "#303740", marginRight: 8 },
  loginInput: { flex: 1, fontSize: 16, color: "#11161D" },
  loginPrimary: { marginTop: 15, minHeight: 53, borderRadius: 15, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  loginPrimaryText: { color: "#FFF", fontSize: 15, fontWeight: "900" },
  loginLegal: { color: "#969DA7", fontSize: 10, lineHeight: 15, textAlign: "center", marginTop: 12 },
  backLogin: { alignSelf: "flex-start", paddingVertical: 3 },
  backLoginText: { color: C.primary, fontWeight: "800" },
  loginBold: { color: "#303740", fontWeight: "800" },
  otpInput: { marginTop: 18, minHeight: 62, borderWidth: 1, borderColor: "#DCE1E7", borderRadius: 15, textAlign: "center", fontSize: 26, fontWeight: "900", letterSpacing: 8, color: "#11161D" },
  resendButton: { alignItems: "center", paddingVertical: 13 },
  resendText: { color: C.primary, fontSize: 12, fontWeight: "800" },

  /* Gemeinsame Typo */
  eyebrow: { color: C.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },

  /* Karte / Overlay */
  mapOverlay: { flex: 1, justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 8 },
  searchBar: { minHeight: 56, backgroundColor: "#FFF", borderRadius: 18, paddingLeft: 14, flexDirection: "row", alignItems: "center", gap: 8, ...shadow },
  searchInput: { flex: 1, fontSize: 16, color: C.ink, minWidth: 0 },
  searchAction: { marginRight: 6, backgroundColor: C.primary, borderRadius: 13, width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  resultsCard: { marginTop: 8, backgroundColor: "#FFF", borderRadius: 18, overflow: "hidden", ...shadow },
  resultRow: { minHeight: 66, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  resultIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#EAF3FF", alignItems: "center", justifyContent: "center" },
  resultTitle: { fontSize: 15, fontWeight: "800", color: C.ink },
  resultSub: { fontSize: 11, color: C.sub, marginTop: 3 },
  chipScroll: { marginTop: 10, flexGrow: 0 },
  chipRow: { gap: 8, paddingRight: 8 },
  quickChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FFF", paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999, ...shadow, shadowOpacity: 0.1, elevation: 5 },
  quickChipText: { fontSize: 12, fontWeight: "800", color: C.ink },
  mapButtons: { alignItems: "flex-end", marginTop: 10, gap: 8 },
  mapButton: { minWidth: 48, minHeight: 48, paddingHorizontal: 10, borderRadius: 16, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", ...shadow, shadowOpacity: 0.11, elevation: 7 },
  mapButtonLabel: { fontSize: 9, fontWeight: "800", color: "#555D68", marginTop: 1 },
  zoomGroup: { width: 48, borderRadius: 16, backgroundColor: "#FFF", overflow: "hidden", ...shadow, shadowOpacity: 0.11, elevation: 7 },
  zoomButton: { height: 46, alignItems: "center", justifyContent: "center" },
  zoomDivider: { height: StyleSheet.hairlineWidth, backgroundColor: "#DDE1E6", marginHorizontal: 8 },

  /* Marker */
  userMarker: { width: 64, height: 64, alignItems: "center", justifyContent: "center" },
  userCone: { position: "absolute", top: 0, width: 0, height: 0, borderLeftWidth: 18, borderRightWidth: 18, borderBottomWidth: 30, borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: "rgba(20,121,255,0.30)" },
  userDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.primary, borderWidth: 3, borderColor: "#FFF", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  userDotArrow: { width: 0, height: 0, marginBottom: 1, borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 10, borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: "#FFF" },
  stopDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 3, borderColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 4 },
  destPin: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#F04438", borderWidth: 3, borderColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 4 },
  wpDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.purple, borderWidth: 3, borderColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 4 },
  wpStart: { backgroundColor: C.green },
  wpText: { color: "#FFF", fontSize: 11, fontWeight: "900" },

  /* Bottom Sheet (Karte & Ersteller) */
  sheet: { backgroundColor: "#FFF", borderTopLeftRadius: 28, borderTopRightRadius: 28, marginHorizontal: -12, marginBottom: -1, padding: 16, paddingBottom: 12, shadowColor: "#0B1220", shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: -5 }, elevation: 16 },
  handle: { width: 42, height: 5, borderRadius: 5, backgroundColor: "#D8DDE4", alignSelf: "center", marginBottom: 12 },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sheetTitle: { fontSize: 22, fontWeight: "900", color: C.ink, marginTop: 2 },
  vToggle: { flexDirection: "row", backgroundColor: "#EFF2F6", padding: 3, borderRadius: 12 },
  vOpt: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 9 },
  vOptOn: { backgroundColor: "#FFF", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
  vText: { fontSize: 11, fontWeight: "800", color: "#707884" },
  vTextOn: { color: C.ink },
  routeModeSwitch: { flexDirection: "row", backgroundColor: "#EEF1F5", padding: 3, borderRadius: 13, marginTop: 10 },
  routeModeOpt: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 10 },
  routeModeOptOn: { backgroundColor: "#FFF", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
  routeModeText: { fontSize: 11, fontWeight: "800", color: "#707884" },
  routeModeTextOn: { color: C.ink },
  hintCard: { marginTop: 12, backgroundColor: "#F6F8FB", borderRadius: 18, padding: 14 },
  hintTitle: { fontWeight: "900", color: C.ink, fontSize: 15 },
  hintText: { color: C.sub, fontSize: 12, lineHeight: 18, marginTop: 5 },
  hintButton: { marginTop: 12, minHeight: 48, borderRadius: 14, backgroundColor: C.green, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 16 },
  hintButtonText: { color: "#FFF", fontWeight: "900", fontSize: 14 },
  routeCard: { marginTop: 12, backgroundColor: "#F6F8FB", borderRadius: 18, padding: 13 },
  routeTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeBadge: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  routeTitle: { fontSize: 16, fontWeight: "900", color: C.ink },
  routeSub: { fontSize: 11, color: C.sub, marginTop: 2 },
  routeStats: { flexDirection: "row", gap: 8, marginTop: 11 },
  pill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#FFF", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  pillText: { fontSize: 12, fontWeight: "800", color: "#2A3038" },
  goButton: { minHeight: 50, borderRadius: 15, marginTop: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  goButtonText: { color: "#FFF", fontWeight: "900", fontSize: 15 },

  /* Navigation */
  navTop: { backgroundColor: "#FFF", borderRadius: 22, minHeight: 88, padding: 11, flexDirection: "row", alignItems: "center", ...shadow, shadowOpacity: 0.16, elevation: 9 },
  navTurnIcon: { width: 58, height: 58, borderRadius: 18, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  navTurnArrow: { color: "#FFF", fontSize: 34, fontWeight: "900" },
  navDirection: { flex: 1, paddingHorizontal: 12 },
  navMeters: { color: C.primary, fontSize: 25, fontWeight: "900" },
  navTurnText: { color: C.ink, fontSize: 13, fontWeight: "800", marginTop: 2 },
  stopButton: { backgroundColor: "#EEF0F3", borderRadius: 11, paddingHorizontal: 10, paddingVertical: 9 },
  stopText: { color: "#252B33", fontSize: 11, fontWeight: "900" },
  navBottom: { marginBottom: 12, backgroundColor: "#FFF", borderRadius: 22, padding: 12, flexDirection: "row", alignItems: "center", ...shadow, shadowOpacity: 0.16, elevation: 10 },
  speedCircle: { width: 66, height: 66, borderRadius: 33, borderWidth: 4, borderColor: C.primary, alignItems: "center", justifyContent: "center", marginRight: 6 },
  speedOver: { backgroundColor: "#F04438", borderColor: "#B42318" },
  speedVal: { fontSize: 22, fontWeight: "900", color: C.primary, lineHeight: 24 },
  speedUnit: { fontSize: 8, fontWeight: "900", color: C.primary },
  speedValOver: { color: "#FFF" },
  navStat: { flex: 1, alignItems: "center" },
  navBig: { fontSize: 14, fontWeight: "900", color: C.ink, textAlign: "center" },
  navSmall: { fontSize: 9, color: "#7B838E", marginTop: 3, textAlign: "center" },
  navLine: { width: StyleSheet.hairlineWidth, height: 36, backgroundColor: "#DDE1E6" },

  /* Seiten */
  pageBg: { flex: 1, backgroundColor: C.bg },
  pageContent: { paddingHorizontal: 18, paddingTop: 64, paddingBottom: 30 },
  pageTitle: { fontSize: 32, fontWeight: "900", color: C.ink, marginTop: 3 },
  pageSub: { fontSize: 13, color: C.sub, marginTop: 5, lineHeight: 19 },

  /* Routen-Tab */
  segment: { flexDirection: "row", backgroundColor: "#E7EBF1", padding: 4, borderRadius: 14, marginTop: 18 },
  segOpt: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 11 },
  segOn: { backgroundColor: "#FFF", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 5, elevation: 2 },
  segText: { fontSize: 13, fontWeight: "800", color: "#707884" },
  segTextOn: { color: C.ink },
  hero: { marginTop: 14, backgroundColor: "#0B1F3A", borderRadius: 26, padding: 20, overflow: "hidden" },
  heroGlowA: { position: "absolute", right: -40, top: -40, width: 160, height: 160, borderRadius: 80, backgroundColor: "rgba(16,185,129,0.35)" },
  heroGlowB: { position: "absolute", right: 30, bottom: -60, width: 140, height: 140, borderRadius: 70, backgroundColor: "rgba(20,121,255,0.35)" },
  heroEyebrow: { color: "#6EE7B7", fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  heroTitle: { color: "#FFF", fontSize: 25, fontWeight: "900", marginTop: 6, lineHeight: 30 },
  heroText: { color: "#B9C6DA", fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 14 },
  heroBtn: { marginTop: 14, minHeight: 50, borderRadius: 15, backgroundColor: "#FFF", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  heroBtnText: { color: "#0B1F3A", fontWeight: "900", fontSize: 15 },
  heroStage: { color: "#B9C6DA", fontSize: 12, textAlign: "center", marginTop: 10 },
  filterScroll: { marginTop: 14, flexGrow: 0 },
  fChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FFF", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: C.line },
  fChipOn: { backgroundColor: C.ink, borderColor: C.ink },
  fChipText: { fontSize: 12, fontWeight: "800", color: C.ink },
  fChipTextOn: { color: "#FFF" },
  rCard: { marginTop: 14, backgroundColor: "#FFF", borderRadius: 22, padding: 14, ...shadow, shadowOpacity: 0.07, elevation: 3 },
  rTop: { flexDirection: "row", gap: 12 },
  thumb: { backgroundColor: "#F1F5F2", borderRadius: 16 },
  rTitle: { fontSize: 16, fontWeight: "900", color: C.ink, lineHeight: 21 },
  rMeta: { fontSize: 12, color: C.sub, marginTop: 4, fontWeight: "600" },
  scoreRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 9 },
  scoreTrack: { flex: 1, height: 7, borderRadius: 4, backgroundColor: "#EDF0F4", overflow: "hidden" },
  scoreFill: { height: 7, borderRadius: 4 },
  scoreText: { fontSize: 12, fontWeight: "900", width: 38, textAlign: "right" },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 11 },
  tag: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  tagText: { fontSize: 11, fontWeight: "800" },
  rHighlights: { fontSize: 12, color: C.sub, marginTop: 10, lineHeight: 17 },
  rActions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 13 },
  iconBtn: { width: 46, height: 46, borderRadius: 14, backgroundColor: "#F2F4F7", alignItems: "center", justifyContent: "center" },
  ghostBtn: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: "#F2F4F7", alignItems: "center", justifyContent: "center" },
  ghostText: { fontWeight: "800", fontSize: 14, color: C.ink },
  goBtn: { flex: 1, minHeight: 46, borderRadius: 14, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" },
  goText: { color: "#FFF", fontWeight: "900", fontSize: 14 },
  emptyCard: { marginTop: 16, backgroundColor: "#FFF", borderRadius: 22, padding: 22, alignItems: "center", ...shadow, shadowOpacity: 0.06, elevation: 3 },
  emptyTitle: { fontSize: 17, fontWeight: "900", color: C.ink, marginTop: 10 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 19, marginTop: 8, textAlign: "center" },

  /* Plus-Tab (Ersteller) */
  creatorTop: { backgroundColor: "#FFF", borderRadius: 22, padding: 14, ...shadow },
  creatorTitle: { fontSize: 22, fontWeight: "900", color: C.ink, marginTop: 2 },
  creatorHint: { fontSize: 12, color: C.sub, lineHeight: 17, marginTop: 5 },
  miniBtn: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#EAF3FF", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, marginTop: 10 },
  miniBtnText: { fontSize: 12, fontWeight: "800", color: C.primary },
  statRow: { flexDirection: "row", gap: 8 },
  statBox: { flex: 1, backgroundColor: "#F6F8FB", borderRadius: 14, paddingVertical: 10, alignItems: "center", justifyContent: "center", minHeight: 58 },
  statBoxVal: { fontSize: 15, fontWeight: "900", color: C.ink },
  statBoxLabel: { fontSize: 10, color: C.sub, marginTop: 3, fontWeight: "700" },
  nameInput: { marginTop: 11, minHeight: 48, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, fontSize: 15, color: C.ink },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  saveBtn: { flex: 1, marginTop: 0, backgroundColor: C.purple },

  /* Karten-Seiten (Freunde / Profil) */
  genericCard: { marginTop: 22, backgroundColor: "#FFF", borderRadius: 22, padding: 20, ...shadow, shadowOpacity: 0.06, elevation: 3 },
  genericIcon: { width: 54, height: 54, borderRadius: 17, backgroundColor: "#EDF5FF", alignItems: "center", justifyContent: "center" },
  genericTitle: { fontSize: 19, fontWeight: "900", color: C.ink, marginTop: 14 },
  genericText: { fontSize: 13, color: C.sub, lineHeight: 19, marginTop: 6 },
  idCard: { marginTop: 13, backgroundColor: "#11161D", borderRadius: 20, padding: 19 },
  idLabel: { color: "#9EA6B1", fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  idValue: { color: "#FFF", fontSize: 28, fontWeight: "900", marginTop: 5 },
  idHint: { color: "#AEB5BE", fontSize: 11, marginTop: 5 },
  profileHero: { marginTop: 21, backgroundColor: "#FFF", borderRadius: 22, padding: 17, flexDirection: "row", alignItems: "center", ...shadow, shadowOpacity: 0.06, elevation: 3 },
  avatar: { width: 67, height: 67, borderRadius: 34, backgroundColor: C.primary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFF", fontSize: 29, fontWeight: "900" },
  profileHeroInfo: { flex: 1, marginLeft: 13 },
  profileName: { fontSize: 21, fontWeight: "900", color: "#12171E" },
  profileHandle: { color: "#7A828D", fontSize: 12, marginTop: 2 },
  profileIdPill: { alignSelf: "flex-start", marginTop: 7, backgroundColor: "#EDF5FF", borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  profileIdPillText: { color: C.primary, fontSize: 10, fontWeight: "900" },
  editButton: { backgroundColor: "#F0F2F5", borderRadius: 11, paddingHorizontal: 10, paddingVertical: 9 },
  editButtonText: { fontSize: 10, fontWeight: "900", color: "#303740" },
  profileStats: { marginTop: 11, backgroundColor: "#FFF", borderRadius: 19, paddingVertical: 17, flexDirection: "row", ...shadow, shadowOpacity: 0.05, elevation: 2 },
  stat: { flex: 1, alignItems: "center" },
  statValue: { fontSize: 18, fontWeight: "900", color: C.ink },
  statLabel: { color: "#7A828D", fontSize: 10, marginTop: 3 },
  settingCard: { marginTop: 11, backgroundColor: "#FFF", borderRadius: 19, padding: 17 },
  settingTitle: { fontSize: 14, fontWeight: "900", color: C.ink, marginBottom: 12 },
  settingMain: { fontSize: 13, fontWeight: "800", color: "#242A32" },
  settingSub: { fontSize: 11, color: "#7B838E", marginTop: 3, lineHeight: 16 },
  privacyRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  privacyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#28B463" },

  /* Untere Leiste */
  bottomSafe: { backgroundColor: "#FFF", shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: -3 }, elevation: 16 },
  bottomNav: { height: 66, backgroundColor: "#FFF", flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 8 },
  navItem: { flex: 1, height: 62, alignItems: "center", justifyContent: "center", gap: 3 },
  navLabel: { fontSize: 10, color: "#98A2B3", fontWeight: "800" },
  navLabelActive: { color: C.primary },
  plusBtn: { width: 54, height: 54, borderRadius: 19, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", shadowColor: C.primary, shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  plusBtnActive: { backgroundColor: C.purple, transform: [{ scale: 1.06 }] },
});
