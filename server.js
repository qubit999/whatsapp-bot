const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { Perplexity } = require("@perplexity-ai/perplexity_ai");
const youtubeSearch = require("youtube-search-api");
const { YtDlp } = require("ytdlp-nodejs");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const satellite = require("satellite.js");

// Deutsche Bahn API base URL (v6 is the current working version)
const DB_API_BASE = "https://v6.db.transport.rest";

// TLE API for satellite tracking
const TLE_API_BASE = "https://tle.ivanstanojevic.me/api";

// AviationStack API for flight data
const AVIATIONSTACK_API_KEY = process.env.AVIATIONSTACK_API_KEY;
const AVIATIONSTACK_API_BASE = "https://api.aviationstack.com/v1";

// Maximum file size to send directly via WhatsApp
// Files larger than this will be uploaded to Gofile and sent as a link
const MAX_SEND_SIZE_MB = 1;

// Upload file to Gofile.io and return download link
async function uploadToGofile(filePath, filename) {
  console.log(`Uploading ${filename} to Gofile...`);
  
  // Step 1: Get best server
  const serverResponse = await fetch('https://api.gofile.io/servers');
  const serverData = await serverResponse.json();
  
  if (serverData.status !== 'ok' || !serverData.data?.servers?.length) {
    throw new Error('Failed to get Gofile server');
  }
  
  const server = serverData.data.servers[0].name;
  console.log(`Using Gofile server: ${server}`);
  
  // Step 2: Upload file using curl (more reliable for large files)
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-X', 'POST',
      `https://${server}.gofile.io/contents/uploadfile`,
      '-F', `file=@${filePath};filename=${filename}`,
      '-s'  // silent mode
    ]);
    
    let stdout = '';
    let stderr = '';
    
    curl.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    curl.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    curl.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`curl failed with code ${code}: ${stderr}`));
        return;
      }
      
      try {
        const uploadData = JSON.parse(stdout);
        
        if (uploadData.status !== 'ok') {
          reject(new Error(`Gofile upload failed: ${uploadData.status}`));
          return;
        }
        
        const downloadPage = uploadData.data.downloadPage;
        console.log(`Upload successful: ${downloadPage}`);
        resolve(downloadPage);
      } catch (parseError) {
        reject(new Error(`Failed to parse Gofile response: ${stdout}`));
      }
    });
    
    curl.on('error', (err) => {
      reject(new Error(`curl error: ${err.message}`));
    });
  });
}

// Helper function to fetch with retry
async function fetchDBApi(urlPath, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `${DB_API_BASE}${urlPath}`;
      console.log(`DB API attempt ${attempt}: ${url}`);
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
      
      const response = await fetch(url, { 
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'WhatsApp-Bot/1.0'
        }
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        return await response.json();
      }
      
      if (response.status === 503 || response.status === 502 || response.status === 504 || response.status === 500) {
        console.log(`DB API returned ${response.status}, retrying in ${attempt * 2}s...`);
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      
      throw new Error(`DB API error: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError') {
        console.log(`DB API timeout, attempt ${attempt}`);
      } else {
        console.log(`DB API error: ${error.message}`);
      }
      
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  
  throw lastError || new Error('DB API unavailable');
}

// Search for a station by name
async function searchDBStation(query) {
  const data = await fetchDBApi(`/locations?query=${encodeURIComponent(query)}&results=1`);
  if (!data || data.length === 0) throw new Error(`Station not found: ${query}`);
  return data[0];
}

// Get journeys between two stations
async function getDBJourneys(fromId, toId, departure) {
  return await fetchDBApi(`/journeys?from=${fromId}&to=${toId}&departure=${encodeURIComponent(departure)}&results=6&stopovers=false`);
}

// Format journey for WhatsApp message
function formatDBJourneys(journeys, fromName, toName) {
  if (!journeys.journeys || journeys.journeys.length === 0) {
    return "No journeys found.";
  }

  let result = `🚂 *Journeys from ${fromName} to ${toName}*\n\n`;

  journeys.journeys.forEach((journey, index) => {
    const legs = journey.legs.filter(leg => leg.line); // Only legs with trains (not walking)
    const allLegs = journey.legs;
    const firstLeg = allLegs[0];
    const lastLeg = allLegs[allLegs.length - 1];
    
    const depTime = new Date(firstLeg.departure);
    const arrTime = new Date(lastLeg.arrival);
    const duration = Math.round((arrTime - depTime) / 60000); // minutes
    const hours = Math.floor(duration / 60);
    const mins = duration % 60;
    
    const depTimeStr = depTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const arrTimeStr = arrTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    
    // Check for delays
    const depDelay = firstLeg.departureDelay ? ` (+${Math.round(firstLeg.departureDelay / 60)}')` : '';
    const arrDelay = lastLeg.arrivalDelay ? ` (+${Math.round(lastLeg.arrivalDelay / 60)}')` : '';
    
    const transfers = legs.length - 1;
    const transferText = transfers === 0 ? 'Direct' : `${transfers} transfer${transfers > 1 ? 's' : ''}`;
    
    result += `*${index + 1}.* ${depTimeStr}${depDelay} → ${arrTimeStr}${arrDelay}\n`;
    result += `   ⏱ ${hours}h ${mins}m | ${transferText}\n`;
    
    // Show detailed leg information
    legs.forEach((leg, legIndex) => {
      const legDepTime = new Date(leg.departure);
      const legArrTime = new Date(leg.arrival);
      const legDepStr = legDepTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const legArrStr = legArrTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      
      const trainName = leg.line?.name || leg.line?.product || 'Train';
      const fromStation = leg.origin?.name || 'Unknown';
      const toStation = leg.destination?.name || 'Unknown';
      
      const depPlatform = leg.departurePlatform ? ` Pl.${leg.departurePlatform}` : '';
      const arrPlatform = leg.arrivalPlatform ? ` Pl.${leg.arrivalPlatform}` : '';
      
      // Delay info for this leg
      const legDepDelay = leg.departureDelay ? ` +${Math.round(leg.departureDelay / 60)}'` : '';
      const legArrDelay = leg.arrivalDelay ? ` +${Math.round(leg.arrivalDelay / 60)}'` : '';
      
      result += `   🚆 *${trainName}*\n`;
      result += `      ${legDepStr}${legDepDelay} ${fromStation}${depPlatform}\n`;
      result += `      ${legArrStr}${legArrDelay} ${toStation}${arrPlatform}\n`;
      
      // Show transfer time if not last leg
      if (legIndex < legs.length - 1) {
        const nextLeg = legs[legIndex + 1];
        const nextDepTime = new Date(nextLeg.departure);
        const transferMins = Math.round((nextDepTime - legArrTime) / 60000);
        result += `   ⏳ _${transferMins} min transfer_\n`;
      }
    });
    
    result += '\n';
  });

  return result;
}

// Geocoding using Geoapify (better for zip codes) with Nominatim fallback
async function geocodeAddress(address) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  
  // Try Geoapify first if API key is available (better for zip codes)
  if (apiKey) {
    try {
      const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(address)}&limit=1&apiKey=${apiKey}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.features && data.features.length > 0) {
          const feature = data.features[0];
          return {
            lat: feature.properties.lat,
            lon: feature.properties.lon,
            displayName: feature.properties.formatted
          };
        }
      }
    } catch (e) {
      console.log('Geoapify geocoding failed, trying Nominatim:', e.message);
    }
  }
  
  // Fallback to Nominatim
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
  });
  if (!response.ok) throw new Error(`Geocoding error: ${response.status}`);
  const data = await response.json();
  if (data.length === 0) throw new Error(`Address not found: ${address}`);
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name
  };
}

// Fetch popular satellites from TLE API
async function fetchSatellites(limit = 100) {
  const url = `${TLE_API_BASE}/tle?page-size=${limit}&sort=popularity&sort-dir=desc`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
  });
  if (!response.ok) throw new Error(`TLE API error: ${response.status}`);
  const data = await response.json();
  return data.member || [];
}

// Calculate satellite position and check if visible from location
function getSatellitePosition(tle, observerLat, observerLon, observerAlt = 0) {
  try {
    // Parse TLE
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    
    // Get current time
    const now = new Date();
    
    // Propagate satellite position
    const positionAndVelocity = satellite.propagate(satrec, now);
    if (!positionAndVelocity.position) return null;
    
    // Get position in Earth-Centered Inertial (ECI) coordinates
    const positionEci = positionAndVelocity.position;
    
    // Convert to geodetic coordinates
    const gmst = satellite.gstime(now);
    const positionGd = satellite.eciToGeodetic(positionEci, gmst);
    
    // Satellite latitude/longitude/altitude
    const satLat = satellite.degreesLat(positionGd.latitude);
    const satLon = satellite.degreesLong(positionGd.longitude);
    const satAlt = positionGd.height; // km
    
    // Observer position in radians
    const observerGd = {
      latitude: satellite.degreesToRadians(observerLat),
      longitude: satellite.degreesToRadians(observerLon),
      height: observerAlt / 1000 // km
    };
    
    // Calculate look angles (azimuth, elevation, range)
    const lookAngles = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(positionEci, gmst));
    
    const elevation = satellite.radiansToDegrees(lookAngles.elevation);
    const azimuth = satellite.radiansToDegrees(lookAngles.azimuth);
    const range = lookAngles.rangeSat; // km
    
    return {
      name: tle.name,
      satelliteId: tle.satelliteId,
      lat: satLat,
      lon: satLon,
      altitude: satAlt,
      elevation: elevation,
      azimuth: azimuth,
      range: range,
      visible: elevation > 0 // Above horizon
    };
  } catch (e) {
    console.log(`Error calculating position for ${tle.name}: ${e.message}`);
    return null;
  }
}

// Get satellites visible from a location
async function getSatellitesAbove(lat, lon, minElevation = 10) {
  const satellites = await fetchSatellites(200); // Get top 200 popular satellites
  const visible = [];
  
  for (const sat of satellites) {
    if (!sat.line1 || !sat.line2) continue;
    
    const pos = getSatellitePosition(sat, lat, lon);
    if (pos && pos.elevation >= minElevation) {
      visible.push(pos);
    }
  }
  
  // Sort by elevation (highest first)
  visible.sort((a, b) => b.elevation - a.elevation);
  
  return visible;
}

// Search satellites by name
async function searchSatellites(query, limit = 10) {
  const url = `${TLE_API_BASE}/tle?search=${encodeURIComponent(query)}&page-size=${limit}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
  });
  if (!response.ok) throw new Error(`TLE API error: ${response.status}`);
  const data = await response.json();
  return data.member || [];
}

// Get current position of a specific satellite
function getSatelliteCurrentPosition(tle) {
  try {
    const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
    const now = new Date();
    const positionAndVelocity = satellite.propagate(satrec, now);
    if (!positionAndVelocity.position) return null;
    
    const positionEci = positionAndVelocity.position;
    const velocityEci = positionAndVelocity.velocity;
    const gmst = satellite.gstime(now);
    const positionGd = satellite.eciToGeodetic(positionEci, gmst);
    
    // Calculate velocity magnitude (km/s)
    const velocity = Math.sqrt(
      velocityEci.x * velocityEci.x +
      velocityEci.y * velocityEci.y +
      velocityEci.z * velocityEci.z
    );
    
    return {
      name: tle.name,
      satelliteId: tle.satelliteId,
      lat: satellite.degreesLat(positionGd.latitude),
      lon: satellite.degreesLong(positionGd.longitude),
      altitude: positionGd.height,
      velocity: velocity,
      date: tle.date
    };
  } catch (e) {
    return null;
  }
}

// Format direction from azimuth
function azimuthToDirection(azimuth) {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(azimuth / 22.5) % 16;
  return directions[index];
}

// Fetch static map image from Geoapify
async function fetchStaticMap(lat, lon, zoom = 15) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    console.log('GEOAPIFY_API_KEY not set, skipping map image');
    return null;
  }
  
  const width = 600;
  const height = 400;
  
  // Geoapify static map API
  const mapUrls = [
    `https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=${width}&height=${height}&center=lonlat:${lon},${lat}&zoom=${zoom}&marker=lonlat:${lon},${lat};color:%23ff0000;size:large&apiKey=${apiKey}`,
  ];
  
  for (const mapUrl of mapUrls) {
    try {
      console.log(`Trying map URL: ${mapUrl}`);
      const response = await fetch(mapUrl, {
        headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
      });
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer).toString('base64');
      }
    } catch (e) {
      console.log(`Map fetch failed: ${e.message}`);
    }
  }
  return null;
}

// Fetch route map image with route line
async function fetchRouteMap(fromLat, fromLon, toLat, toLon, routeGeometry) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    console.log('GEOAPIFY_API_KEY not set, skipping route map image');
    return null;
  }
  
  const width = 600;
  const height = 400;
  
  // Build polyline from route geometry (Geoapify format: lon,lat|lon,lat|...)
  let polyline = '';
  if (routeGeometry && routeGeometry.coordinates) {
    const coords = routeGeometry.coordinates;
    // Sample points to keep URL manageable (max ~80 points for URL length)
    const step = Math.max(1, Math.floor(coords.length / 80));
    const points = [];
    for (let i = 0; i < coords.length; i += step) {
      points.push(`${coords[i][0]},${coords[i][1]}`); // lon,lat format
    }
    // Always include last point
    if (coords.length > 1) {
      const last = coords[coords.length - 1];
      points.push(`${last[0]},${last[1]}`);
    }
    polyline = points.join('|');
  }
  
  // Calculate bounding box with padding for better zoom
  const minLat = Math.min(fromLat, toLat);
  const maxLat = Math.max(fromLat, toLat);
  const minLon = Math.min(fromLon, toLon);
  const maxLon = Math.max(fromLon, toLon);
  const latPad = (maxLat - minLat) * 0.15 || 0.01;
  const lonPad = (maxLon - minLon) * 0.15 || 0.01;
  
  // Geoapify with markers, route line, and area (auto-zoom to fit)
  // area=rect:minLon,minLat,maxLon,maxLat auto-fits the map
  let mapUrl = `https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=${width}&height=${height}`;
  mapUrl += `&area=rect:${minLon - lonPad},${minLat - latPad},${maxLon + lonPad},${maxLat + latPad}`;
  mapUrl += `&marker=lonlat:${fromLon},${fromLat};color:%2322cc22;size:large;type:awesome|lonlat:${toLon},${toLat};color:%23dd2222;size:large;type:awesome`;
  
  // Add route line if we have geometry
  if (polyline) {
    mapUrl += `&geometry=polyline:${encodeURIComponent(polyline)};linecolor:%233388ff;linewidth:4`;
  }
  
  mapUrl += `&apiKey=${apiKey}`;
  
  try {
    console.log(`Fetching route map with polyline (${routeGeometry?.coordinates?.length || 0} points)`);
    const response = await fetch(mapUrl, {
      headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
    });
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    } else {
      console.log(`Route map API error: ${response.status}`);
    }
  } catch (e) {
    console.log(`Route map fetch failed: ${e.message}`);
  }
  return null;
}

// Calculate zoom level based on radius
function radiusToZoom(radiusMeters) {
  // Approximate zoom levels for different radii
  if (radiusMeters <= 100) return 18;
  if (radiusMeters <= 250) return 17;
  if (radiusMeters <= 500) return 16;
  if (radiusMeters <= 1000) return 15;
  if (radiusMeters <= 2000) return 14;
  if (radiusMeters <= 5000) return 13;
  if (radiusMeters <= 10000) return 12;
  if (radiusMeters <= 20000) return 11;
  if (radiusMeters <= 50000) return 10;
  return 9;
}

// Get route from OSRM
async function getRoute(fromLat, fromLon, toLat, toLon) {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'WhatsApp-Bot/1.0' }
  });
  if (!response.ok) throw new Error(`Routing error: ${response.status}`);
  const data = await response.json();
  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    throw new Error('No route found');
  }
  return data.routes[0];
}

// Get static map with route
function getRouteMapUrl(fromLat, fromLon, toLat, toLon, routeGeometry) {
  // Calculate bounding box
  const minLat = Math.min(fromLat, toLat);
  const maxLat = Math.max(fromLat, toLat);
  const minLon = Math.min(fromLon, toLon);
  const maxLon = Math.max(fromLon, toLon);
  
  // Center point
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  
  // Calculate zoom based on distance
  const latDiff = maxLat - minLat;
  const lonDiff = maxLon - minLon;
  const maxDiff = Math.max(latDiff, lonDiff);
  let zoom = 12;
  if (maxDiff > 2) zoom = 6;
  else if (maxDiff > 1) zoom = 7;
  else if (maxDiff > 0.5) zoom = 8;
  else if (maxDiff > 0.2) zoom = 9;
  else if (maxDiff > 0.1) zoom = 10;
  else if (maxDiff > 0.05) zoom = 11;
  else if (maxDiff > 0.02) zoom = 12;
  else if (maxDiff > 0.01) zoom = 13;
  else zoom = 14;
  
  // Encode route path for URL (simplified - take every nth point)
  const coords = routeGeometry.coordinates;
  const step = Math.max(1, Math.floor(coords.length / 100)); // Max 100 points
  const pathPoints = [];
  for (let i = 0; i < coords.length; i += step) {
    pathPoints.push(`${coords[i][1]},${coords[i][0]}`);
  }
  // Always include last point
  if (coords.length > 1) {
    pathPoints.push(`${coords[coords.length-1][1]},${coords[coords.length-1][0]}`);
  }
  const pathStr = pathPoints.join('|');
  
  // Build URL with markers and path
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${centerLat},${centerLon}&zoom=${zoom}&size=600x400&markers=${fromLat},${fromLon},green-pushpin|${toLat},${toLon},red-pushpin&path=${pathStr}`;
}

// Format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${mins}min`;
  }
  return `${mins} min`;
}

// Format distance
function formatDistance(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

// Load dotenv only if available (for local development)
try {
  require("dotenv").config({ path: "./.env" });
} catch (e) {
  // dotenv not installed, using env_file from docker-compose
}

console.log("=== Environment Debug ===");
console.log("NODE_ENV:", process.env.NODE_ENV || "(not set)");
console.log("=========================");

// Initialize ytdlp-nodejs
const ytdlp = new YtDlp();
let ffmpegAvailable = false;
let ffmpegPath = "ffmpeg"; // Default, will be updated if found elsewhere

// Find FFmpeg path - check common locations
function findFFmpegPath() {
  const possiblePaths =
    process.platform === "win32"
      ? [
          "ffmpeg",
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA || "", "ffmpeg", "ffmpeg.exe"),
          path.join(
            __dirname,
            "node_modules",
            "ytdlp-nodejs",
            "bin",
            "ffmpeg.exe"
          ),
          path.join(__dirname, "node_modules", ".bin", "ffmpeg.exe"),
        ]
      : [
          "ffmpeg",
          "/usr/local/bin/ffmpeg",
          "/usr/bin/ffmpeg",
          path.join(__dirname, "node_modules", "ytdlp-nodejs", "bin", "ffmpeg"),
        ];

  for (const p of possiblePaths) {
    if (p === "ffmpeg") continue; // Skip default, check it last
    if (fs.existsSync(p)) {
      console.log(`✓ Found FFmpeg at: ${p}`);
      return p;
    }
  }
  return "ffmpeg"; // Fall back to PATH
}

// Check and download FFmpeg if needed (for proper video conversion)
async function ensureFFmpeg() {
  try {
    const isInstalled = ytdlp.checkInstallation({ ffmpeg: true });
    if (isInstalled) {
      console.log("✓ FFmpeg is available");
      ffmpegAvailable = true;
      ffmpegPath = findFFmpegPath();
      return true;
    }
  } catch (error) {
    // checkInstallation throws if FFmpeg path is not set
    console.log("FFmpeg not found, attempting to download...");
  }

  try {
    await ytdlp.downloadFFmpeg();
    console.log("✓ FFmpeg downloaded successfully");
    ffmpegAvailable = true;
    ffmpegPath = findFFmpegPath();
    return true;
  } catch (error) {
    console.warn("Could not download FFmpeg:", error.message);
    console.warn("Videos may be in MPEG-TS format instead of MP4");
    ffmpegAvailable = false;
    return false;
  }
}

// Run FFmpeg check on startup and wait for it
ensureFFmpeg().catch(console.error);

// Detect Chrome executable path based on OS
function getChromePath() {
  if (process.platform === "win32") {
    const possiblePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log(`✓ Found Chrome at: ${p}`);
        return p;
      }
    }
    return undefined;
  } else if (process.platform === "darwin") {
    const macPath =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(macPath)) {
      console.log(`✓ Found Chrome at: ${macPath}`);
      return macPath;
    }
    return undefined;
  } else {
    // Linux/Docker
    const linuxPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter(Boolean);
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        console.log(`✓ Found Chrome at: ${p}`);
        return p;
      }
    }
    return undefined;
  }
}

// Use local Chrome - RemoteAuth doesn't work with WebSocket browsers
const puppeteerConfig = {
  executablePath: getChromePath(),
  headless: true,
  timeout: 120000, // 2 minute timeout for operations
  protocolTimeout: 300000, // 5 minute protocol timeout for large file uploads
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--no-first-run",
    "--no-zygote",
    "--disable-extensions",
    // Stability improvements for large files
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--disable-features=TranslateUI",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--js-flags=--max-old-space-size=8192", // 8GB JS heap for large files
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-features=AudioServiceOutOfProcess",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--force-color-profile=srgb",
    "--enable-features=NetworkService,NetworkServiceInProcess",
  ],
};

// Helper function to send media with retry logic for large files
async function sendMediaWithRetry(chat, media, options = {}, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Sending media attempt ${attempt}/${maxRetries}...`);
      await chat.sendMessage(media, options);
      return true;
    } catch (error) {
      console.error(`Send attempt ${attempt} failed:`, error.message);
      
      // Don't retry if session/browser crashed - it won't recover
      if (error.message.includes("Session closed") || 
          error.message.includes("Target closed") ||
          error.message.includes("Protocol error")) {
        console.error("Browser session crashed - no point retrying");
        throw error;
      }
      
      if (attempt === maxRetries) {
        throw error;
      }
      // Wait before retry (exponential backoff)
      const waitTime = 2000 * attempt;
      console.log(`Waiting ${waitTime}ms before retry...`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
  return false;
}

console.log("=== Puppeteer Config ===");
console.log("Using local Chrome");
console.log("Config:", JSON.stringify(puppeteerConfig, null, 2));
console.log("========================");

// Use LocalAuth with volume mount for session persistence
// Since we're mounting .wwebjs_auth as a Docker volume, LocalAuth is simpler
// The session directory will persist across container restarts
const authStrategy = new LocalAuth({
  clientId: "whatsapp-bot",
  dataPath: "./.wwebjs_auth",
});

console.log("=== Auth Strategy ===");
console.log("Using: LocalAuth (volume-mounted)");
console.log("=====================");

const client = new Client({
  authStrategy: authStrategy,
  puppeteer: puppeteerConfig,
});

const client_perplexity = new Perplexity({
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
});

// Create temp directories if they don't exist
const TEMP_DIR = path.join(__dirname, "temp");
const TEMP_DIR_MP4 = path.join(TEMP_DIR, "mp4");
const TEMP_DIR_MP3 = path.join(TEMP_DIR, "mp3");
if (!fs.existsSync(TEMP_DIR_MP4)) {
  fs.mkdirSync(TEMP_DIR_MP4, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR_MP3)) {
  fs.mkdirSync(TEMP_DIR_MP3, { recursive: true });
}

// Convert video to MP4 (H.264 + AAC) for iOS/Android compatibility
async function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Converting ${path.basename(inputPath)} to MP4...`);

    const args = [
      "-i",
      inputPath,
      "-c:v",
      "libx264", // H.264 video codec
      "-c:a",
      "aac", // AAC audio codec
      "-preset",
      "fast", // Faster encoding
      "-crf",
      "23", // Quality (lower = better, 18-28 is good)
      "-movflags",
      "+faststart", // Enable streaming
      "-y", // Overwrite output
      outputPath,
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
      // Log progress (FFmpeg outputs to stderr)
      const match = data.toString().match(/time=(\d{2}:\d{2}:\d{2})/);
      if (match) {
        process.stdout.write(`\rConverting: ${match[1]}`);
      }
    });

    ffmpeg.on("close", (code) => {
      console.log(""); // New line after progress
      if (code === 0) {
        console.log(`✓ Converted to MP4 successfully`);
        resolve(outputPath);
      } else {
        reject(
          new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`)
        );
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`FFmpeg error: ${err.message}`));
    });
  });
}

async function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Converting ${path.basename(inputPath)} to MP3...`);

    const args = [
      "-i",
      inputPath,
      "-vn", // Disable video (no video output)
      "-acodec",
      "libmp3lame", // MP3 audio codec
      "-ab",
      "192k", // Audio bitrate (192 kbps)
      "-ar",
      "44100", // Sample rate (44.1 kHz)
      "-y", // Overwrite output
      outputPath, // Should end with .mp3
    ];
    const ffmpeg = spawn(ffmpegPath, args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
      // Log progress (FFmpeg outputs to stderr)
      const match = data.toString().match(/time=(\d{2}:\d{2}:\d{2})/);
      if (match) {
        process.stdout.write(`\rConverting: ${match[1]}`);
      }
    });

    ffmpeg.on("close", (code) => {
      console.log(""); // New line after progress
      if (code === 0) {
        console.log(`✓ Converted to MP4 successfully`);
        resolve(outputPath);
      } else {
        reject(
          new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`)
        );
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`FFmpeg error: ${err.message}`));
    });
  });
}

async function download_video(url, filename, fileType) {
  const baseFilename = filename.replace(/\.[^.]+$/, ""); // Remove any extension
  const targetDir = fileType === "mp3" ? TEMP_DIR_MP3 : TEMP_DIR_MP4;
  const filePath = path.join(targetDir, `${baseFilename}.${fileType}`);

  // Check if converted MP4/MP3 already exists in cache
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    if (stats.size > 0) {
      console.log(`✓ Found cached MP4: ${filePath}`);
      console.log(`  Cache size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      return filePath;
    }
    fs.unlinkSync(filePath);
  }

  // Check if original file exists (any extension) - we can convert it
  const cachedFiles = fs
    .readdirSync(targetDir)
    .filter(
      (f) =>
        f.startsWith(baseFilename) &&
        !f.includes(".part") &&
        !f.includes(".f") &&
        !f.endsWith(".mp4") &&
        !f.endsWith(".mp3")
    );

  if (cachedFiles.length > 0) {
    const originalPath = path.join(targetDir, cachedFiles[0]);
    const stats = fs.statSync(originalPath);
    if (stats.size > 0) {
      console.log(`✓ Found cached original: ${originalPath}`);
      // Convert to MP4/MP3
      if (ffmpegAvailable) {
        try {
          if (fileType === "mp3") await convertToMp3(originalPath, filePath);
          else await convertToMp4(originalPath, filePath);
          return filePath;
        } catch (error) {
          console.error("Conversion failed:", error.message);
          // Fall back to original
          return originalPath;
        }
      }
      return originalPath;
    }
    fs.unlinkSync(originalPath);
  }

  // Clean up any partial downloads
  const partialFiles = fs
    .readdirSync(targetDir)
    .filter(
      (f) =>
        f.startsWith(baseFilename) && (f.includes(".f") || f.includes(".part"))
    );
  partialFiles.forEach((f) => {
    const partialPath = path.join(targetDir, f);
    if (fs.existsSync(partialPath)) {
      fs.unlinkSync(partialPath);
    }
  });

  console.log(`Starting download for: ${baseFilename}`);

  try {
    // Use the global ffmpegAvailable flag set during startup
    const hasFFmpeg = ffmpegAvailable;

    console.log(`Using format: 720p max (FFmpeg: ${hasFFmpeg ? "yes" : "no"})`);

    let trimmed_url = url.trim();

    // Use downloadAsync with explicit 720p format selector
    if (fileType === "mp3") {
      format_option = "bv[height<=?720]+ba/b[height<=?720]";
    } else {
      format_option = "bv[height<=?720]+ba/b[height<=?720]";
    }

    await ytdlp.downloadAsync(trimmed_url, {
      format: hasFFmpeg
        ? format_option // Best video ≤720p + best audio, or best combined ≤720p
        : "b[height<=?720]", // Best combined format ≤720p (no merge needed)
      output: path.join(targetDir, baseFilename),
      additionalArgs: ["--extractor-args", "youtube:player_client=android"], // Use android client to avoid SABR streaming issues
      onProgress: (progress) => {
        if (progress.percent) {
          console.log(`Download progress: ${progress.percent}%`);
        }
      },
    });

    console.log("Download completed");
  } catch (error) {
    console.error("ytdlp-nodejs error:", error);
    throw new Error(`Download failed: ${error.message}`);
  }

  // Find the downloaded file
  const downloadedFiles = fs
    .readdirSync(targetDir)
    .filter(
      (f) =>
        f.startsWith(baseFilename) && !f.includes(".part") && !f.includes(".f")
    );

  if (downloadedFiles.length === 0) {
    throw new Error(`File not created for ${baseFilename}`);
  }

  // Sort to get the most recently created file
  const sortedFiles = downloadedFiles.sort((a, b) => {
    const aTime = fs.statSync(path.join(targetDir, a)).mtimeMs;
    const bTime = fs.statSync(path.join(targetDir, b)).mtimeMs;
    return bTime - aTime;
  });

  const downloadedPath = path.join(targetDir, sortedFiles[0]);
  const ext = path.extname(downloadedPath).toLowerCase();

  console.log(`Downloaded file: ${sortedFiles[0]}`);

  const stats = fs.statSync(downloadedPath);
  console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  if (stats.size === 0) {
    throw new Error("Downloaded file is empty");
  }

  console.log(`FFmpeg available: ${ffmpegAvailable}, path: ${ffmpegPath}`);

  if (ffmpegAvailable) {
    try {
      if (fileType === "mp3") await convertToMp3(downloadedPath, filePath);
      else await convertToMp4(downloadedPath, filePath);
      return filePath;
    } catch (error) {
      console.error("Conversion failed, using original:", error.message);
      return downloadedPath;
    }
  }

  // If already MP4, rename to expected path
  if (ext === ".mp4" && downloadedPath !== filePath) {
    fs.renameSync(downloadedPath, filePath);
    return filePath;
  }

  if (ext === ".mp3" && downloadedPath !== filePath) {
    fs.renameSync(downloadedPath, filePath);
    return filePath;
  }

  console.log("✓ File downloaded successfully");
  return downloadedPath;
}

async function getYouTubeVideoInfo(url) {
  try {
    const info = await ytdlp.getInfoAsync(url, {
      additionalArgs: ["--extractor-args", "youtube:player_client=android"],
    });
    return info;
  } catch (error) {
    console.error("Error getting video info:", error);
    throw new Error("Failed to get video information");
  }
}

async function searchYouTube(query) {
  try {
    const results = await youtubeSearch.GetListByKeyword(query, false, 15);
    let formattedString = "";
    results.items.forEach((video, index) => {
      const title = video.title || "No title";
      const videoId = video.id;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const channelTitle = video.channelTitle || "Unknown channel";
      const length = video.length?.simpleText || "N/A";
      const isLive = video.isLive ? " (Live)" : "";
      formattedString += `Channel: ${channelTitle}\n`;
      formattedString += `${index + 1}. ${title} ${isLive}\n`;
      formattedString += `Length: ${length}\n`;
      formattedString += `URL: ${url}\n`;
      formattedString += `\n`;
    });
    return formattedString;
  } catch (error) {
    console.error("Error searching YouTube:", error);
    throw error;
  }
}

async function get_completion(input) {
  const completion = await client_perplexity.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant. Give concise answers. Keep it brief.",
      },
      {
        role: "user",
        content: input,
      },
    ],
    model: "sonar",
  });
  return completion.choices[0].message.content;
}

function tokenizer(input) {
  let message = input;
  let search_term = message.split(" ");
  let only_search = [];
  let command = search_term[0];
  search_term.shift();
  for (let word of search_term) {
    if (word == "" || word == " ") continue;
    only_search.push(word.replace(" ", ""));
  }
  return [command, only_search];
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Client is ready!");
});

client.on("authenticated", () => {
  console.log("✓ Client authenticated!");
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failure:", msg);
});

client.on("disconnected", (reason) => {
  console.log("Client disconnected:", reason);
});

client.on("message_create", async (msg) => {
  let [command, only_search] = tokenizer(msg.body);
  const chat = await msg.getChat();

  if (command == "!ping") {
    await chat.sendMessage("pong");
    await chat.sendMessage("Search terms: " + only_search.join(" "));
  }

  if (command == "!llm") {
    let query = only_search.join(" ");
    let response = await get_completion(query);
    await chat.sendMessage("Q: " + query + "\nA: " + response);
  }

  if (command == "!yt") {
    let query = only_search.join(" ");
    let yt_results = await searchYouTube(query);
    await chat.sendMessage(
      "YouTube Search Results for: " + query + "\n\n" + yt_results
    );
  }

  if (command == "!db") {
    try {
      if (only_search.length < 2) {
        await chat.sendMessage(
          "❌ Usage: !db <from> <to> [date] [time]\n" +
          "Examples:\n" +
          "  !db Berlin Hamburg\n" +
          "  !db Berlin Hamburg 25.12 14:00\n" +
          "  !db \"Frankfurt Main\" München 25.12 14:00"
        );
        return;
      }

      // Parse arguments - support quoted station names
      const fullArgs = only_search.join(" ");
      let from, to, dateStr, timeStr;
      
      // Check for quoted strings
      const quotedMatch = fullArgs.match(/"([^"]+)"/g);
      if (quotedMatch && quotedMatch.length >= 2) {
        from = quotedMatch[0].replace(/"/g, '');
        to = quotedMatch[1].replace(/"/g, '');
        // Get remaining args after quotes for date/time
        const remaining = fullArgs.replace(/"[^"]+"/g, '').trim().split(/\s+/).filter(Boolean);
        dateStr = remaining[0];
        timeStr = remaining[1];
      } else {
        // Simple space-separated args
        from = only_search[0];
        to = only_search[1];
        dateStr = only_search[2];
        timeStr = only_search[3];
      }

      await chat.sendMessage(`🔍 Searching connections from *${from}* to *${to}*...`);

      // Search for stations
      const fromStation = await searchDBStation(from);
      const toStation = await searchDBStation(to);

      // Build departure time
      let departure;
      if (dateStr && timeStr) {
        // Parse date (DD.MM or DD.MM.YYYY) and time (HH:MM)
        const [day, month, year] = dateStr.split('.');
        const [hour, minute] = timeStr.split(':');
        const now = new Date();
        const depYear = year ? parseInt(year) : now.getFullYear();
        const depMonth = parseInt(month) - 1;
        const depDay = parseInt(day);
        const depHour = parseInt(hour);
        const depMinute = parseInt(minute);
        departure = new Date(depYear, depMonth, depDay, depHour, depMinute).toISOString();
      } else if (dateStr) {
        // Only date provided, use current time
        const [day, month, year] = dateStr.split('.');
        const now = new Date();
        const depYear = year ? parseInt(year) : now.getFullYear();
        departure = new Date(depYear, parseInt(month) - 1, parseInt(day), now.getHours(), now.getMinutes()).toISOString();
      } else {
        // Use current time
        departure = new Date().toISOString();
      }

      // Get journeys
      const journeys = await getDBJourneys(fromStation.id, toStation.id, departure);
      
      // Format and send response
      const formatted = formatDBJourneys(journeys, fromStation.name, toStation.name);
      await chat.sendMessage(formatted);

    } catch (error) {
      console.error("Error fetching DB journeys:", error);
      await chat.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  if (command == "!location") {
    try {
      // Parse directly from msg.body to preserve quoted strings
      let fullText = msg.body.substring("!location".length).trim();
      
      // Normalize all quote types to standard double quotes
      fullText = fullText.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036"«»]/g, '"');
      
      // Parse quoted address and optional radius
      const quotedMatch = fullText.match(/"([^"]+)"/);
      if (!quotedMatch) {
        await chat.sendMessage(
          '❌ Usage: !location "<address>" [radius_m]\n' +
          'Examples:\n' +
          '  !location "Berlin Alexanderplatz"\n' +
          '  !location "Eiffel Tower, Paris" 500\n' +
          '  !location "Tullastraße 10, Karlsruhe" 200'
        );
        return;
      }
      
      const address = quotedMatch[1];
      const remaining = fullText.replace(/"[^"]+"/, '').trim();
      const radius = parseInt(remaining) || 500; // Default 500m radius
      
      await chat.sendMessage(`🔍 Looking up: ${address}...`);
      
      // Geocode the address
      const location = await geocodeAddress(address);
      const zoom = radiusToZoom(radius);
      
      // Try to fetch static map image
      const mapImage = await fetchStaticMap(location.lat, location.lon, zoom);
      
      // Prepare the caption/message
      const locationMsg = `📍 *${address}*\n\n${location.displayName}\n\n🌐 Coordinates: ${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}\n\n🗺️ Google Maps:\nhttps://www.google.com/maps?q=${location.lat},${location.lon}\n\n🗺️ OpenStreetMap:\nhttps://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}&zoom=${zoom}`;
      
      if (mapImage) {
        // Send map image with caption
        const media = new MessageMedia('image/png', mapImage, 'location.png');
        await chat.sendMessage(media, { caption: locationMsg });
      } else {
        // Fallback to text only
        await chat.sendMessage(locationMsg);
      }
      
    } catch (error) {
      console.error("Error getting location:", error);
      await chat.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  if (command == "!route") {
    try {
      // Parse directly from msg.body to preserve quoted strings
      let fullText = msg.body.substring("!route".length).trim();
      
      // Normalize all quote types to standard double quotes
      fullText = fullText.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036"«»]/g, '"');
      
      // Parse two quoted addresses
      const quotedMatches = fullText.match(/"([^"]+)"/g);
      if (!quotedMatches || quotedMatches.length < 2) {
        await chat.sendMessage(
          '❌ Usage: !route "<from_address>" "<to_address>"\n' +
          'Example:\n' +
          '  !route "Berlin Hbf" "Munich Hbf"\n' +
          '  !route "Paris, France" "Amsterdam, Netherlands"'
        );
        return;
      }
      
      const fromAddress = quotedMatches[0].replace(/"/g, '');
      const toAddress = quotedMatches[1].replace(/"/g, '');
      
      await chat.sendMessage(`🔍 Calculating route:\n📍 From: ${fromAddress}\n📍 To: ${toAddress}`);
      
      // Geocode both addresses
      const fromLocation = await geocodeAddress(fromAddress);
      const toLocation = await geocodeAddress(toAddress);
      
      // Get route
      const route = await getRoute(fromLocation.lat, fromLocation.lon, toLocation.lat, toLocation.lon);
      
      // Format route info
      const distance = formatDistance(route.distance);
      const duration = formatDuration(route.duration);
      
      // Try to fetch route map image with the route line
      const mapImage = await fetchRouteMap(fromLocation.lat, fromLocation.lon, toLocation.lat, toLocation.lon, route.geometry);
      
      // Prepare the message
      const routeMsg = `🚗 *Route*\n\n🟢 *From:* ${fromAddress}\n📍 ${fromLocation.displayName}\n\n🔴 *To:* ${toAddress}\n📍 ${toLocation.displayName}\n\n📏 *Distance:* ${distance}\n⏱ *Duration:* ${duration}\n\n🗺️ *View Route:*\nhttps://www.google.com/maps/dir/${fromLocation.lat},${fromLocation.lon}/${toLocation.lat},${toLocation.lon}\n\n🗺️ *OpenStreetMap:*\nhttps://www.openstreetmap.org/directions?from=${fromLocation.lat},${fromLocation.lon}&to=${toLocation.lat},${toLocation.lon}`;
      
      if (mapImage) {
        // Send map image with caption
        const media = new MessageMedia('image/png', mapImage, 'route.png');
        await chat.sendMessage(media, { caption: routeMsg });
      } else {
        // Fallback to text only
        await chat.sendMessage(routeMsg);
      }
      
    } catch (error) {
      console.error("Error getting route:", error);
      await chat.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  // Search satellites by name
  if (command == "!satsearch" || command == "!findsat") {
    try {
      let fullText = msg.body.substring(command.length).trim();
      
      // Normalize quotes (WhatsApp uses curly quotes)
      fullText = fullText.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036«»]/g, '"');
      
      // Parse quoted satellite name
      const quotedMatch = fullText.match(/"([^"]+)"/);
      if (!quotedMatch) {
        await chat.sendMessage(
          '❌ Usage: !satsearch "<satellite name>"\n' +
          'Example:\n' +
          '  !satsearch "ISS"\n' +
          '  !satsearch "Starlink"\n' +
          '  !findsat "Hubble"'
        );
        return;
      }
      
      const query = quotedMatch[1];
      
      await chat.sendMessage(`🔍 Searching for satellites matching "${query}"...`);
      
      // Search for satellites
      const satellites = await searchSatellites(query, 15);
      
      if (satellites.length === 0) {
        await chat.sendMessage(`🛰️ No satellites found matching "${query}"`);
        return;
      }
      
      let result = `🛰️ *Satellites matching "${query}"*\n`;
      result += `🕐 ${new Date().toLocaleString('de-DE')}\n\n`;
      
      for (const sat of satellites) {
        if (!sat.line1 || !sat.line2) continue;
        
        const pos = getSatelliteCurrentPosition(sat);
        if (pos) {
          result += `*${pos.name}* (ID: ${pos.satelliteId})\n`;
          result += `   📍 Position: ${pos.lat.toFixed(2)}°, ${pos.lon.toFixed(2)}°\n`;
          result += `   🌍 Altitude: ${pos.altitude.toFixed(0)} km\n`;
          result += `   🚀 Speed: ${(pos.velocity * 3600).toFixed(0)} km/h\n`;
          result += `   🔗 Track: https://www.n2yo.com/?s=${pos.satelliteId}\n\n`;
        } else {
          result += `*${sat.name}* (ID: ${sat.satelliteId})\n`;
          result += `   ⚠️ Position data unavailable\n\n`;
        }
      }
      
      await chat.sendMessage(result);
      
    } catch (error) {
      console.error("Error searching satellites:", error);
      await chat.sendMessage(`❌ Error: ${error.message}`);
    }
  }

  // Flight details from AviationStack
  if (command == "!flight") {
    try {
      if (!AVIATIONSTACK_API_KEY) {
        await chat.sendMessage("❌ AviationStack API key not configured.");
        return;
      }

      const flightCode = only_search.join("").trim().toUpperCase();
      
      if (!flightCode) {
        await chat.sendMessage(
          "❌ Usage: !flight <flight_code>\n\n" +
          "Examples:\n" +
          "  !flight LH123\n" +
          "  !flight UA456\n" +
          "  !flight BA789"
        );
        return;
      }

      // Extract airline code and flight number
      const match = flightCode.match(/^([A-Z]{2})(\d+)$/);
      if (!match) {
        await chat.sendMessage(
          `❌ Invalid flight code: ${flightCode}\n\n` +
          "Format: 2 letters + numbers (e.g., LH123, UA456)"
        );
        return;
      }

      await chat.sendMessage(`✈️ Searching for flight ${flightCode}...`);

      // Search for the flight
      const url = `${AVIATIONSTACK_API_BASE}/flights?access_key=${AVIATIONSTACK_API_KEY}&flight_iata=${flightCode}&limit=1`;
      console.log(`Fetching flight: ${url.replace(AVIATIONSTACK_API_KEY, "XXX")}`);
      
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error.message || data.error.code || "API error");
      }

      if (!data.data || data.data.length === 0) {
        await chat.sendMessage(
          `❌ Flight ${flightCode} not found.\n\n` +
          "💡 Tips:\n" +
          "• Check if the flight code is correct\n" +
          "• Flight may not be scheduled today\n" +
          "• Try with full code (e.g., LH123)"
        );
        return;
      }

      const flight = data.data[0];
      const dep = flight.departure || {};
      const arr = flight.arrival || {};
      const airline = flight.airline || {};
      const flightInfo = flight.flight || {};
      const aircraft = flight.aircraft || {};
      const live = flight.live || null;

      // Format times with timezone
      const formatTime = (timeStr, timezone) => {
        if (!timeStr) return "—";
        if (timezone) {
          try {
            const time = new Date(timeStr).toLocaleTimeString("de-DE", { 
              hour: "2-digit", 
              minute: "2-digit",
              timeZone: timezone 
            });
            // Get timezone abbreviation
            const tzAbbr = new Date(timeStr).toLocaleTimeString("en-US", {
              timeZone: timezone,
              timeZoneName: "short"
            }).split(" ").pop();
            return `${time} (${tzAbbr})`;
          } catch (e) {
            return timeStr.substring(11, 16);
          }
        }
        return timeStr.substring(11, 16);
      };

      const formatDate = (timeStr) => {
        if (!timeStr) return "—";
        return new Date(timeStr).toLocaleDateString("de-DE", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
          year: "numeric"
        });
      };

      // Calculate flight duration
      let flightDuration = "—";
      if (dep.scheduled && arr.scheduled) {
        const depTime = new Date(dep.scheduled);
        const arrTime = new Date(arr.scheduled);
        const durationMs = arrTime - depTime;
        const hours = Math.floor(durationMs / (1000 * 60 * 60));
        const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        flightDuration = `${hours}h ${minutes}min`;
      }

      // Status emoji and text
      const status = flight.flight_status || "unknown";
      const statusInfo = {
        "scheduled": { emoji: "⚪", text: "Scheduled" },
        "active": { emoji: "🔵", text: "In Flight" },
        "landed": { emoji: "🟢", text: "Landed" },
        "cancelled": { emoji: "🔴", text: "Cancelled" },
        "incident": { emoji: "🔴", text: "Incident" },
        "diverted": { emoji: "🟠", text: "Diverted" },
        "delayed": { emoji: "🟡", text: "Delayed" }
      };
      const statusDisplay = statusInfo[status] || { emoji: "⚪", text: status };

      // Build result message
      let result = `✈️ *Flight ${flightInfo.iata || flightCode}*\n`;
      result += `━━━━━━━━━━━━━━━━━━\n\n`;

      // Airline info
      result += `🏢 *Airline:* ${airline.name || "—"}\n`;
      if (flightInfo.codeshared) {
        result += `🔗 *Codeshare:* ${flightInfo.codeshared.airline_name} ${flightInfo.codeshared.flight_iata}\n`;
      }
      result += `\n`;

      // Status
      result += `${statusDisplay.emoji} *Status:* ${statusDisplay.text}\n`;
      if (dep.delay && dep.delay > 0) {
        result += `⚠️ *Delay:* +${dep.delay} min\n`;
      }
      result += `\n`;

      // Departure info
      result += `🛫 *DEPARTURE*\n`;
      result += `   📍 ${dep.airport || "—"} (${dep.iata || "—"})\n`;
      result += `   📅 ${formatDate(dep.scheduled)}\n`;
      result += `   🕐 Scheduled: ${formatTime(dep.scheduled, dep.timezone)}\n`;
      if (dep.estimated && dep.estimated !== dep.scheduled) {
        result += `   🕐 Estimated: ${formatTime(dep.estimated, dep.timezone)}\n`;
      }
      if (dep.actual) {
        result += `   🕐 Actual: ${formatTime(dep.actual, dep.timezone)}\n`;
      }
      if (dep.terminal) result += `   🏛️ Terminal: ${dep.terminal}\n`;
      if (dep.gate) result += `   🚪 Gate: ${dep.gate}\n`;
      result += `\n`;

      // Arrival info
      result += `🛬 *ARRIVAL*\n`;
      result += `   📍 ${arr.airport || "—"} (${arr.iata || "—"})\n`;
      result += `   📅 ${formatDate(arr.scheduled)}\n`;
      result += `   🕐 Scheduled: ${formatTime(arr.scheduled, arr.timezone)}\n`;
      if (arr.estimated && arr.estimated !== arr.scheduled) {
        result += `   🕐 Estimated: ${formatTime(arr.estimated, arr.timezone)}\n`;
      }
      if (arr.actual) {
        result += `   🕐 Actual: ${formatTime(arr.actual, arr.timezone)}\n`;
      }
      if (arr.terminal) result += `   🏛️ Terminal: ${arr.terminal}\n`;
      if (arr.gate) result += `   🚪 Gate: ${arr.gate}\n`;
      if (arr.baggage) result += `   🧳 Baggage: ${arr.baggage}\n`;
      result += `\n`;

      // Flight info
      result += `⏱️ *FLIGHT INFO*\n`;
      result += `   ⏳ Duration: ${flightDuration}\n`;
      if (aircraft.registration) result += `   ✈️ Aircraft: ${aircraft.registration}\n`;
      if (aircraft.iata) result += `   🛩️ Type: ${aircraft.iata}\n`;
      if (flightInfo.icao) result += `   📟 ICAO: ${flightInfo.icao}\n`;

      // Live tracking info if available
      if (live) {
        result += `\n`;
        result += `📡 *LIVE TRACKING*\n`;
        if (live.altitude) result += `   📏 Altitude: ${Math.round(live.altitude * 3.281)} ft\n`;
        if (live.speed_horizontal) result += `   💨 Speed: ${Math.round(live.speed_horizontal * 1.852)} km/h\n`;
        if (live.latitude && live.longitude) {
          result += `   🌍 Position: ${live.latitude.toFixed(4)}, ${live.longitude.toFixed(4)}\n`;
        }
        if (live.is_ground) result += `   🛞 On Ground: Yes\n`;
      }

      await chat.sendMessage(result);

    } catch (error) {
      console.error("Error fetching flight details:", error);
      await chat.sendMessage(
        `❌ Error: ${error.message}\n\n` +
        "💡 This might be due to API limits or invalid flight code."
      );
    }
  }

  if (command == "!help" || command == "!commands") {
    const helpText = `📋 *Available Commands*

*YouTube*
!yt <query> - Search YouTube
!ytdl4 <url> - Download YouTube video as MP4
!ytdl3 <url> - Download YouTube video as MP3

*Cache*
!cache4 - Show cached MP4 videos
!cache3 - Show cached MP3 files
!dl4 <#> - Send cached MP4 by number
!dl3 <#> - Send cached MP3 by number

*Deutsche Bahn*
!db <from> <to> [date] [time] - Search train connections

*Maps*
!location "<address>" [radius_m] - Show map of location
!route "<from>" "<to>" - Get driving route

*Satellites*
!satsearch "<name>" - Search satellites by name

*Flights*
!flight <code> - Detailed flight info (e.g., LH123)

*Other*
!llm <question> - Ask AI a question
!ping - Check if bot is online
!help - Show this help message`;

    await chat.sendMessage(helpText);
  }

  if (command == "!cache4") {
    try {
      const files = fs.readdirSync(TEMP_DIR_MP4).filter(f => f.endsWith('.mp4')).sort((a, b) => {
        const aTime = fs.statSync(path.join(TEMP_DIR_MP4, a)).mtimeMs;
        const bTime = fs.statSync(path.join(TEMP_DIR_MP4, b)).mtimeMs;
        return bTime - aTime; // Newest first
      });

      if (files.length === 0) {
        await chat.sendMessage("📁 MP4 cache is empty. No videos downloaded yet.");
        return;
      }

      let cacheList = "📁 *Cached MP4 Videos*\n\n";
      files.forEach((file, index) => {
        const stats = fs.statSync(path.join(TEMP_DIR_MP4, file));
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        const name = file.replace(".mp4", "").substring(0, 40);
        cacheList += `*#${index + 1}* - ${name}${file.length > 44 ? "..." : ""} (${sizeMB} MB)\n`;
      });

      cacheList += `\n💡 Use !dl4 <#> to send a cached video`;
      await chat.sendMessage(cacheList);
    } catch (error) {
      console.error("Error listing MP4 cache:", error);
      await chat.sendMessage("❌ Error listing cache: " + error.message);
    }
  }

  if (command == "!cache3") {
    try {
      const files = fs.readdirSync(TEMP_DIR_MP3).filter(f => f.endsWith('.mp3')).sort((a, b) => {
        const aTime = fs.statSync(path.join(TEMP_DIR_MP3, a)).mtimeMs;
        const bTime = fs.statSync(path.join(TEMP_DIR_MP3, b)).mtimeMs;
        return bTime - aTime; // Newest first
      });

      if (files.length === 0) {
        await chat.sendMessage("📁 MP3 cache is empty. No audio files downloaded yet.");
        return;
      }

      let cacheList = "🎵 *Cached MP3 Files*\n\n";
      files.forEach((file, index) => {
        const stats = fs.statSync(path.join(TEMP_DIR_MP3, file));
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        const name = file.replace(".mp3", "").substring(0, 40);
        cacheList += `*#${index + 1}* - ${name}${file.length > 44 ? "..." : ""} (${sizeMB} MB)\n`;
      });

      cacheList += `\n💡 Use !dl3 <#> to send a cached MP3`;
      await chat.sendMessage(cacheList);
    } catch (error) {
      console.error("Error listing MP3 cache:", error);
      await chat.sendMessage("❌ Error listing cache: " + error.message);
    }
  }

  if (command == "!dl4") {
    try {
      const index = parseInt(only_search[0]?.replace("#", "")) - 1;

      if (isNaN(index)) {
        await chat.sendMessage(
          "❌ Please provide a valid number.\nUsage: !dl4 #1 or !dl4 1"
        );
        return;
      }

      const files = fs.readdirSync(TEMP_DIR_MP4).filter(f => f.endsWith('.mp4')).sort((a, b) => {
        const aTime = fs.statSync(path.join(TEMP_DIR_MP4, a)).mtimeMs;
        const bTime = fs.statSync(path.join(TEMP_DIR_MP4, b)).mtimeMs;
        return bTime - aTime;
      });

      if (index < 0 || index >= files.length) {
        await chat.sendMessage(
          `❌ Invalid number. Use !cache4 to see available videos (1-${files.length}).`
        );
        return;
      }

      const filePath = path.join(TEMP_DIR_MP4, files[index]);
      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;

      // For large files, upload to Gofile and send link
      if (fileSizeMB > MAX_SEND_SIZE_MB) {
        await chat.sendMessage(
          `📤 File is ${fileSizeMB.toFixed(1)} MB - uploading to Gofile...\n⏳ This may take a moment.`
        );
        
        try {
          const downloadLink = await uploadToGofile(filePath, files[index]);
          await chat.sendMessage(
            `✅ *Upload complete!*\n\n` +
            `📁 ${files[index]}\n` +
            `📊 Size: ${fileSizeMB.toFixed(1)} MB\n\n` +
            `🔗 Download: ${downloadLink}\n\n` +
            `💡 Link expires after some time of inactivity.`
          );
        } catch (uploadError) {
          console.error("Gofile upload failed:", uploadError);
          await chat.sendMessage(
            `❌ Upload failed: ${uploadError.message}\n\n` +
            `📁 File is saved locally at:\n${filePath}`
          );
        }
        return;
      }

      await chat.sendMessage(
        `📤 Sending: ${files[index]} (${fileSizeMB.toFixed(1)} MB)...`
      );

      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString("base64");
      const media = new MessageMedia(
        "video/mp4",
        base64Data,
        files[index],
        stats.size
      );

      await sendMediaWithRetry(chat, media, {
        sendMediaAsDocument: true,
      }, 2);

      await chat.sendMessage("✅ Video sent successfully!");
    } catch (error) {
      console.error("Error sending cached video:", error);
      if (error.message.includes("Target closed") || error.message.includes("Protocol error")) {
        await chat.sendMessage("❌ Error: Chrome crashed while sending large file. Try a smaller file or restart the bot.");
      } else {
        await chat.sendMessage("❌ Error: " + error.message);
      }
    }
  }

  if (command == "!dl3") {
    try {
      const index = parseInt(only_search[0]?.replace("#", "")) - 1;

      if (isNaN(index)) {
        await chat.sendMessage(
          "❌ Please provide a valid number.\nUsage: !dl3 #1 or !dl3 1"
        );
        return;
      }

      const files = fs.readdirSync(TEMP_DIR_MP3).filter(f => f.endsWith('.mp3')).sort((a, b) => {
        const aTime = fs.statSync(path.join(TEMP_DIR_MP3, a)).mtimeMs;
        const bTime = fs.statSync(path.join(TEMP_DIR_MP3, b)).mtimeMs;
        return bTime - aTime;
      });

      if (index < 0 || index >= files.length) {
        await chat.sendMessage(
          `❌ Invalid number. Use !cache3 to see available MP3s (1-${files.length}).`
        );
        return;
      }

      const filePath = path.join(TEMP_DIR_MP3, files[index]);
      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;

      // For large files, upload to Gofile and send link
      if (fileSizeMB > MAX_SEND_SIZE_MB) {
        await chat.sendMessage(
          `📤 File is ${fileSizeMB.toFixed(1)} MB - uploading to Gofile...\n⏳ This may take a moment.`
        );
        
        try {
          const downloadLink = await uploadToGofile(filePath, files[index]);
          await chat.sendMessage(
            `✅ *Upload complete!*\n\n` +
            `📁 ${files[index]}\n` +
            `📊 Size: ${fileSizeMB.toFixed(1)} MB\n\n` +
            `🔗 Download: ${downloadLink}\n\n` +
            `💡 Link expires after some time of inactivity.`
          );
        } catch (uploadError) {
          console.error("Gofile upload failed:", uploadError);
          await chat.sendMessage(
            `❌ Upload failed: ${uploadError.message}\n\n` +
            `📁 File is saved locally at:\n${filePath}`
          );
        }
        return;
      }

      await chat.sendMessage(
        `📤 Sending: ${files[index]} (${fileSizeMB.toFixed(1)} MB)...`
      );

      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString("base64");
      const media = new MessageMedia(
        "audio/mpeg",
        base64Data,
        files[index],
        stats.size
      );

      await sendMediaWithRetry(chat, media, {
        sendMediaAsDocument: true,
      }, 2);

      await chat.sendMessage("✅ MP3 sent successfully!");
    } catch (error) {
      console.error("Error sending cached MP3:", error);
      if (error.message.includes("Target closed") || error.message.includes("Protocol error")) {
        await chat.sendMessage("❌ Error: Chrome crashed while sending large file. Try a smaller file or restart the bot.");
      } else {
        await chat.sendMessage("❌ Error: " + error.message);
      }
    }
  }

  if (command == "!ytdl3") {
    let filePath;
    let videoSentSuccessfully = false;

    try {
      const url = only_search[0].trim();

      // Validate URL
      if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
        await chat.sendMessage(
          "❌ Please provide a valid YouTube URL.\nUsage: !ytdl <youtube_url>"
        );
        return;
      }

      await chat.sendMessage("⏳ Fetching video information...");

      // Get video info
      const videoInfo = await getYouTubeVideoInfo(url);
      const videoTitle = sanitizeFilename(videoInfo.title || "video");
      const filename = `${videoTitle}`;

      // Check if already cached in MP3 folder
      const cachedFiles = fs
        .readdirSync(TEMP_DIR_MP3)
        .filter(
          (f) =>
            f.startsWith(videoTitle) &&
            f.endsWith(".mp3") &&
            !f.includes(".part")
        );
      const isCached =
        cachedFiles.length > 0 &&
        fs.statSync(path.join(TEMP_DIR_MP3, cachedFiles[0])).size > 0;

      if (!isCached) {
        await chat.sendMessage(
          `🎵 Downloading: ${videoInfo.title}\n⏱️ This may take a while...`
        );
      } else {
        await chat.sendMessage(
          `🎵 Found in cache: ${videoInfo.title}\n⚡ Sending immediately...`
        );
      }

      // Download video (returns cached if exists)
      filePath = await download_video(url, filename, "mp3");

      console.log(`✓ Download complete: ${filePath}`);

      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;
      console.log(`✓ File verified: ${fileSizeMB.toFixed(2)} MB`);

      const ext = path.extname(filePath).toLowerCase();
      const outputFilename = `${videoTitle}${ext}`;

      // For large files, upload to Gofile and send link
      if (fileSizeMB > MAX_SEND_SIZE_MB) {
        await chat.sendMessage(
          `✅ ${isCached ? "From cache" : "Download complete"}! (${fileSizeMB.toFixed(1)} MB)\n` +
          `📤 File is large - uploading to Gofile...\n⏳ This may take a moment.`
        );
        
        try {
          const downloadLink = await uploadToGofile(filePath, outputFilename);
          await chat.sendMessage(
            `✅ *Upload complete!*\n\n` +
            `🎵 ${videoInfo.title}\n` +
            `📊 Size: ${fileSizeMB.toFixed(1)} MB\n\n` +
            `🔗 Download: ${downloadLink}\n\n` +
            `💡 Link expires after some time of inactivity.`
          );
          videoSentSuccessfully = true;
        } catch (uploadError) {
          console.error("Gofile upload failed:", uploadError);
          await chat.sendMessage(
            `❌ Upload failed: ${uploadError.message}\n\n` +
            `📁 File is saved - use !cache3 then !dl3 to retry.`
          );
        }
        return;
      }

      await chat.sendMessage(
        `✅ ${
          isCached ? "From cache" : "Download complete"
        }! (${fileSizeMB.toFixed(2)} MB)\n📤 Uploading to WhatsApp...`
      );

      // Send file as document for reliability
      console.log("Creating MessageMedia from file...");
      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString("base64");

      // Get correct MIME type based on actual file extension
      const mimeTypes = {
        ".mp3": "audio/mpeg",
      };
      const mimeType = mimeTypes[ext] || "audio/mpeg";

      console.log(`Sending as ${ext} (${mimeType})...`);

      const media = new MessageMedia(
        mimeType,
        base64Data,
        outputFilename,
        stats.size
      );

      console.log("Sending as document to WhatsApp...");
      await sendMediaWithRetry(chat, media, {
        sendMediaAsDocument: true,
      }, 2);

      videoSentSuccessfully = true;
      await chat.sendMessage("✅ MP3 sent successfully!");
    } catch (error) {
      console.error("Error downloading/sending YouTube audio:", error);
      if (error.message.includes("Target closed") || error.message.includes("Protocol error")) {
        await chat.sendMessage(
          `❌ Error: Chrome crashed while sending file.\n\n💡 Tips:\n• Restart the bot and try again\n• File was saved - use !cache3 then !dl3 to retry`
        );
      } else {
        await chat.sendMessage(
          `❌ Error: ${error.message}\n\n💡 Tip: File may be too large for WhatsApp (limit: 2GB).`
        );
      }
    } finally {
      // Keep cached files for future requests - only clean up partial downloads
      try {
        const files = fs.readdirSync(TEMP_DIR_MP3);
        files.forEach((file) => {
          if (file.includes(".part") || file.includes(".temp")) {
            const partialPath = path.join(TEMP_DIR_MP3, file);
            fs.unlinkSync(partialPath);
            console.log(`Cleaned up partial file: ${file}`);
          }
        });
      } catch (e) {
        console.error("Error cleaning partial files:", e);
      }
    }
  }

  if (command == "!ytdl4") {
    let filePath;
    let videoSentSuccessfully = false;

    try {
      const url = only_search[0].trim();

      // Validate URL
      if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
        await chat.sendMessage(
          "❌ Please provide a valid YouTube URL.\nUsage: !ytdl <youtube_url>"
        );
        return;
      }

      await chat.sendMessage("⏳ Fetching video information...");

      // Get video info
      const videoInfo = await getYouTubeVideoInfo(url);
      const videoTitle = sanitizeFilename(videoInfo.title || "video");
      const filename = `${videoTitle}`;
      const fileType = "mp4";

      // Check if already cached in MP4 folder
      const cachedFiles = fs
        .readdirSync(TEMP_DIR_MP4)
        .filter(
          (f) =>
            f.startsWith(videoTitle) &&
            f.endsWith(".mp4") &&
            !f.includes(".part")
        );
      const isCached =
        cachedFiles.length > 0 &&
        fs.statSync(path.join(TEMP_DIR_MP4, cachedFiles[0])).size > 0;

      if (!isCached) {
        await chat.sendMessage(
          `📹 Downloading: ${videoInfo.title}\n⏱️ This may take a while...`
        );
      } else {
        await chat.sendMessage(
          `📹 Found in cache: ${videoInfo.title}\n⚡ Sending immediately...`
        );
      }

      // Download video (returns cached if exists)
      filePath = await download_video(url, filename, fileType);

      console.log(`✓ Download complete: ${filePath}`);

      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;
      console.log(`✓ File verified: ${fileSizeMB.toFixed(2)} MB`);

      const ext = path.extname(filePath).toLowerCase();
      const outputFilename = `${videoTitle}${ext}`;

      // For large files, upload to Gofile and send link
      if (fileSizeMB > MAX_SEND_SIZE_MB) {
        await chat.sendMessage(
          `✅ ${isCached ? "From cache" : "Download complete"}! (${fileSizeMB.toFixed(1)} MB)\n` +
          `📤 File is large - uploading to Gofile...\n⏳ This may take a moment.`
        );
        
        try {
          const downloadLink = await uploadToGofile(filePath, outputFilename);
          await chat.sendMessage(
            `✅ *Upload complete!*\n\n` +
            `🎬 ${videoInfo.title}\n` +
            `📊 Size: ${fileSizeMB.toFixed(1)} MB\n\n` +
            `🔗 Download: ${downloadLink}\n\n` +
            `💡 Link expires after some time of inactivity.`
          );
          videoSentSuccessfully = true;
        } catch (uploadError) {
          console.error("Gofile upload failed:", uploadError);
          await chat.sendMessage(
            `❌ Upload failed: ${uploadError.message}\n\n` +
            `📁 File is saved - use !cache4 then !dl4 to retry.`
          );
        }
        return;
      }

      await chat.sendMessage(
        `✅ ${
          isCached ? "From cache" : "Download complete"
        }! (${fileSizeMB.toFixed(2)} MB)\n📤 Uploading to WhatsApp...`
      );

      // Send video file as document for reliability
      console.log("Creating MessageMedia from file...");
      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString("base64");

      // Get correct MIME type based on actual file extension
      const mimeTypes = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
      };
      const mimeType = mimeTypes[ext] || "video/mp4";

      console.log(`Sending as ${ext} (${mimeType})...`);

      const media = new MessageMedia(
        mimeType,
        base64Data,
        outputFilename,
        stats.size
      );

      console.log("Sending as document to WhatsApp...");
      await sendMediaWithRetry(chat, media, {
        sendMediaAsDocument: true,
      }, 2);

      videoSentSuccessfully = true;
      await chat.sendMessage("✅ Video sent successfully!");
    } catch (error) {
      console.error("Error downloading/sending YouTube video:", error);
      if (error.message.includes("Target closed") || error.message.includes("Protocol error")) {
        await chat.sendMessage(
          `❌ Error: Chrome crashed while sending large file.\n\n💡 Tips:\n• Try a shorter video\n• Restart the bot and try again\n• File was saved - use !cache4 then !dl4 to retry`
        );
      } else {
        await chat.sendMessage(
          `❌ Error: ${error.message}\n\n💡 Tip: File may be too large for WhatsApp (limit: 2GB).`
        );
      }
    } finally {
      // Keep cached files for future requests - only clean up partial downloads
      try {
        const files = fs.readdirSync(TEMP_DIR_MP4);
        files.forEach((file) => {
          if (file.includes(".part") || file.includes(".temp")) {
            const partialPath = path.join(TEMP_DIR_MP4, file);
            fs.unlinkSync(partialPath);
            console.log(`Cleaned up partial file: ${file}`);
          }
        });
      } catch (e) {
        console.error("Error cleaning partial files:", e);
      }
    }
  }
});

client.initialize();
