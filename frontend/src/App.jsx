import React, { useState, useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { 
  Satellite, 
  Activity, 
  Layers, 
  Download, 
  RefreshCw, 
  Sliders, 
  Calendar,
  AlertTriangle,
  FileCheck,
  CheckCircle2,
  Clock,
  Compass,
  Upload,
  Eye,
  PenTool,
  X,
  MapPin,
  Cpu,
  Sun,
  Moon,
  ChevronDown,
  Check,
  Droplets,
  Waves,
  ArrowDown,
  ArrowUp,
  LineChart,
  Leaf,
  Info,
  Cloud,
  CloudRain,
  Sprout,
  Search,
  EyeOff
} from 'lucide-react';

const get_color_palette = (name) => {
  const palettes = {
    "ET (Dry-Wet)": ['#8B0000', '#FF4500', '#FFFF00', '#00FF00', '#000080'],
    "Red-Yellow-Green (Vegetation)": ['#d7191c', '#fdae61', '#ffffbf', '#a6d96a', '#1a9641'],
    "Blue-White-Green (Water/Veg)": ['#0000ff', '#ffffff', '#008000'],
    "Blue-Yellow-Red (Thermal)": ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'],
    "Viridis (Sequential)": ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    "Magma (Sequential)": ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fcfdbf'],
    "Inferno (Sequential)": ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746'],
    "Plasma (Sequential)": ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
    "Turbo (Rainbow Enhanced)": ['#30123b', '#466be3', '#28bbec', '#32f197', '#a2fc3c', '#f2f221', '#fc8961', '#cf2547', '#7a0403'],
    "Ocean (Water Depth)": ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'],
    "Terrain (Elevation)": ['#006400', '#32CD32', '#FFFF00', '#DAA520', '#8B4513', '#A0522D', '#D2691E', '#CD853F', '#F4A460', '#DEB887', '#D3D3D3', '#FFFFFF'],
    "Greyscale": ['#000000', '#FFFFFF']
  };
  return palettes[name] || palettes["Red-Yellow-Green (Vegetation)"];
};

const API_BASE = "http://127.0.0.1:7000";

// Modes with a "double-click a point on the map to see its value" query feature.
// 'lsm' has its own dedicated dblclick handler (susceptibility API); the rest
// share the generic point-query endpoint against whichever GeoTIFF is on screen.
// Seasonal Trend / ET Time-Series are excluded — they chart a time series, not a
// single queryable raster.
const GENERIC_QUERY_MODES = ['single', 'lulc', 'aef', 'similarity', 'et', 'flood'];
const DBLCLICK_ZOOM_DISABLED_MODES = [...GENERIC_QUERY_MODES, 'lsm'];

const POPUP_HEADER_HTML = `
  <div class="popup-header">
    <svg class="popup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
    <h4>Point Query</h4>
  </div>`;

// --- CLIENT-SIDE PARSERS FOR KML AND GEOJSON ---
const parseKmlText = (text) => {
  try {
    const coordRegex = /<coordinates>([\s\S]*?)<\/coordinates>/i;
    const match = coordRegex.exec(text);
    if (match && match[1]) {
      const coordsRaw = match[1].trim().split(/\s+/);
      const lons = [];
      const lats = [];
      const coordinates = [];
      coordsRaw.forEach(str => {
        const parts = str.split(',');
        if (parts.length >= 2) {
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          lons.push(lon);
          lats.push(lat);
          coordinates.push([lon, lat]);
        }
      });
      if (lons.length > 0) {
        // Form a closed loop for Polygon if start and end don't match
        if (coordinates.length > 0 && 
            (coordinates[0][0] !== coordinates[coordinates.length - 1][0] || 
             coordinates[0][1] !== coordinates[coordinates.length - 1][1])) {
          coordinates.push(coordinates[0]);
        }
        
        const geojson = {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [coordinates]
          },
          properties: {}
        };

        return {
          bounds: {
            minLon: Math.min(...lons),
            maxLon: Math.max(...lons),
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats)
          },
          geojson
        };
      }
    }
  } catch (e) {
    console.error("KML parse error:", e);
  }
  return null;
};

const parseGeoJsonText = (text) => {
  try {
    const geojson = JSON.parse(text);
    let coords = [];
    
    const extractCoords = (geom) => {
      if (!geom) return;
      if (geom.type === "Point") {
        coords.push(geom.coordinates);
      } else if (geom.type === "LineString" || geom.type === "MultiPoint") {
        coords.push(...geom.coordinates);
      } else if (geom.type === "Polygon" || geom.type === "MultiLineString") {
        geom.coordinates.forEach(ring => coords.push(...ring));
      } else if (geom.type === "MultiPolygon") {
        geom.coordinates.forEach(poly => poly.forEach(ring => coords.push(...ring)));
      } else if (geom.type === "GeometryCollection") {
        geom.geometries.forEach(g => extractCoords(g));
      }
    };
    
    if (geojson.type === "FeatureCollection") {
      geojson.features.forEach(f => extractCoords(f.geometry));
    } else if (geojson.type === "Feature") {
      extractCoords(geojson.geometry);
    } else if (geojson.geometry) {
      extractCoords(geojson.geometry);
    } else if (geojson.coordinates) {
      extractCoords(geojson);
    }
    
    if (coords.length > 0) {
      const lons = coords.map(c => c[0]).filter(v => !isNaN(v));
      const lats = coords.map(c => c[1]).filter(v => !isNaN(v));
      if (lons.length > 0) {
        return {
          bounds: {
            minLon: Math.min(...lons),
            maxLon: Math.max(...lons),
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats)
          },
          geojson
        };
      }
    }
  } catch (e) {
    console.error("GeoJSON parse error:", e);
  }
  return null;
};

// Standard Leaflet Marker icon fix
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// --- INTERACTIVE EXCEL-STYLE TIME SERIES CHART ---
function TimeSeriesChart({ data, indexName, onViewScene, activeSceneId }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(300);
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Toggles for Mean, Min, Max lines
  const [showMean, setShowMean] = useState(true);
  const [showMin, setShowMin] = useState(false);
  const [showMax, setShowMax] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const handleResize = () => {
      if (containerRef.current) {
        setWidth(containerRef.current.clientWidth || 300);
      }
    };
    handleResize();
    const observer = new ResizeObserver((entries) => {
      handleResize();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  if (!data || data.length === 0) return null;

  // Chart dimensions
  const height = 220;
  const paddingLeft = 45;
  const paddingRight = 15;
  const paddingTop = 40; // More room for title and legends
  const paddingBottom = 35;

  const chartWidth = Math.max(50, width - paddingLeft - paddingRight);
  const chartHeight = height - paddingTop - paddingBottom;

  // Extract min/max values based on visible series (Excel style)
  const activeYValues = [];
  data.forEach(d => {
    if (showMean && d.mean !== undefined) activeYValues.push(d.mean);
    if (showMin && d.min !== undefined) activeYValues.push(d.min);
    if (showMax && d.max !== undefined) activeYValues.push(d.max);
  });
  
  if (activeYValues.length === 0) {
    data.forEach(d => {
      if (d.mean !== undefined) activeYValues.push(d.mean);
      if (d.min !== undefined) activeYValues.push(d.min);
      if (d.max !== undefined) activeYValues.push(d.max);
    });
  }

  let minY = Math.min(...activeYValues);
  let maxY = Math.max(...activeYValues);
  
  // Padding to Y limits
  const yRange = maxY - minY || 0.1;
  minY = minY - yRange * 0.1;
  maxY = maxY + yRange * 0.1;

  // Coordinate scaling helpers
  const getX = (index) => {
    if (data.length <= 1) return paddingLeft + chartWidth / 2;
    return paddingLeft + (index / (data.length - 1)) * chartWidth;
  };

  const getY = (val) => {
    return paddingTop + chartHeight - ((val - minY) / (maxY - minY)) * chartHeight;
  };

  // Build Excel series path strings
  const buildPath = (key) => {
    if (data.length === 0) return "";
    let pathStr = `M ${getX(0)} ${getY(data[0][key])}`;
    for (let i = 1; i < data.length; i++) {
      pathStr += ` L ${getX(i)} ${getY(data[i][key])}`;
    }
    return pathStr;
  };

  const meanPath = buildPath("mean");
  const minPath = buildPath("min");
  const maxPath = buildPath("max");

  // Y Axis ticks (5 values, clean Excel style grid lines)
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    yTicks.push(minY + (i / 4) * (maxY - minY));
  }

  // X Axis ticks (Excel categories)
  const xTicks = [];
  if (data.length > 0) {
    xTicks.push({ index: 0, date: data[0].date });
    if (data.length > 2) {
      const mid = Math.floor(data.length / 2);
      xTicks.push({ index: mid, date: data[mid].date });
    }
    if (data.length > 1) {
      xTicks.push({ index: data.length - 1, date: data[data.length - 1].date });
    }
  }

  // Handle CSV Export
  const handleExportCSV = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Date,Scene_ID,Mean,Min,Max,Std_Dev,Cloud_Cover\n";
    data.forEach(d => {
      csvContent += `${d.date},${d.scene_id},${d.mean.toFixed(4)},${d.min.toFixed(4)},${d.max.toFixed(4)},${d.std.toFixed(4)},${d.cloud_cover.toFixed(1)}\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `PhytoLens_TimeSeries_${indexName}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Handle Mouse Hover on Canvas (Scrubber)
  const handleMouseMove = (e) => {
    if (!containerRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    
    // Calculate closest index based on X
    const pct = (mouseX - paddingLeft) / chartWidth;
    let idx = Math.round(pct * (data.length - 1));
    idx = Math.max(0, Math.min(data.length - 1, idx));
    
    const point = data[idx];
    setHoveredPoint({ ...point, idx });

    // Determine tooltip position
    const cx = getX(idx);
    // Tooltip snaps to the Mean value or whichever line is visible
    let cy = getY(point.mean);
    if (!showMean && showMax) cy = getY(point.max);
    else if (!showMean && !showMax && showMin) cy = getY(point.min);

    setTooltipPos({ x: cx, y: cy });
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  // Check if active overlay scene is on this date
  const isSceneActive = (sceneId) => {
    return activeSceneId && activeSceneId === sceneId;
  };

  return (
    <div className="excel-chart-card" ref={containerRef}>
      {/* Title */}
      <div className="excel-chart-title text-center">
        {indexName} Seasonal Trend
      </div>

      {/* Legend & Multi-series Checkboxes */}
      <div className="excel-legend-container">
        <label className="flex items-center gap-1 cursor-pointer">
          <input 
            type="checkbox" 
            checked={showMean} 
            onChange={(e) => setShowMean(e.target.checked)} 
            className="excel-checkbox"
          />
          <span className="excel-legend-key" style={{ backgroundColor: '#4472c4' }}></span>
          <span className="excel-legend-text">Mean {indexName}</span>
        </label>
        
        <label className="flex items-center gap-1 cursor-pointer">
          <input 
            type="checkbox" 
            checked={showMax} 
            onChange={(e) => setShowMax(e.target.checked)}
            className="excel-checkbox"
          />
          <span className="excel-legend-key" style={{ backgroundColor: '#ed7d31' }}></span>
          <span className="excel-legend-text">Max {indexName}</span>
        </label>

        <label className="flex items-center gap-1 cursor-pointer">
          <input 
            type="checkbox" 
            checked={showMin} 
            onChange={(e) => setShowMin(e.target.checked)}
            className="excel-checkbox"
          />
          <span className="excel-legend-key" style={{ backgroundColor: '#a5a5a5' }}></span>
          <span className="excel-legend-text">Min {indexName}</span>
        </label>
      </div>

      {/* SVG Canvas */}
      <div className="relative mt-2">
        <svg 
          width="100%" 
          height={height} 
          viewBox={`0 0 ${width} ${height}`} 
          className="trend-svg"
          style={{ overflow: 'visible', cursor: 'crosshair' }}
        >
          {/* Horizontal Gridlines */}
          {yTicks.map((val, idx) => (
            <line 
              key={idx} 
              x1={paddingLeft} 
              y1={getY(val)} 
              x2={width - paddingRight} 
              y2={getY(val)} 
              stroke="#e2e2e2" 
              strokeWidth="0.75"
            />
          ))}

          {/* X and Y Axes Lines */}
          <line 
            x1={paddingLeft} 
            y1={height - paddingBottom} 
            x2={width - paddingRight} 
            y2={height - paddingBottom} 
            stroke="#7f7f7f" 
            strokeWidth="1.2"
          />
          <line 
            x1={paddingLeft} 
            y1={paddingTop} 
            x2={paddingLeft} 
            y2={height - paddingBottom} 
            stroke="#7f7f7f" 
            strokeWidth="1.2"
          />

          {/* Y Axis Labels */}
          {yTicks.map((val, idx) => (
            <text 
              key={idx} 
              x={paddingLeft - 6} 
              y={getY(val) + 3.5} 
              textAnchor="end" 
              className="excel-axis-text"
            >
              {val.toFixed(2)}
            </text>
          ))}

          {/* X Axis Labels */}
          {xTicks.map((t, idx) => (
            <g key={idx}>
              {/* Tick Mark */}
              <line 
                x1={getX(t.index)} 
                y1={height - paddingBottom} 
                x2={getX(t.index)} 
                y2={height - paddingBottom + 4} 
                stroke="#7f7f7f" 
                strokeWidth="1"
              />
              <text 
                x={getX(t.index)} 
                y={height - paddingBottom + 15} 
                textAnchor="middle" 
                className="excel-axis-text"
              >
                {t.date}
              </text>
            </g>
          ))}

          {/* Active Overlay Vertical Line */}
          {data.map((d, idx) => {
            if (isSceneActive(d.scene_id)) {
              return (
                <line
                  key={`active-line-${idx}`}
                  x1={getX(idx)}
                  y1={paddingTop}
                  x2={getX(idx)}
                  y2={height - paddingBottom}
                  stroke="#4472c4"
                  strokeWidth="1.2"
                  strokeDasharray="2, 2"
                  style={{ pointerEvents: 'none' }}
                />
              );
            }
            return null;
          })}

          {/* Min Line (Grey) */}
          {showMin && minPath && (
            <path 
              d={minPath} 
              fill="none" 
              stroke="#a5a5a5" 
              strokeWidth="1.8" 
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Max Line (Orange) */}
          {showMax && maxPath && (
            <path 
              d={maxPath} 
              fill="none" 
              stroke="#ed7d31" 
              strokeWidth="1.8" 
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Mean Line (Blue) */}
          {showMean && meanPath && (
            <path 
              d={meanPath} 
              fill="none" 
              stroke="#4472c4" 
              strokeWidth="2" 
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Snapping Vertical Crosshair Guide */}
          {hoveredPoint && (
            <line
              x1={getX(hoveredPoint.idx)}
              y1={paddingTop}
              x2={getX(hoveredPoint.idx)}
              y2={height - paddingBottom}
              stroke="#7f7f7f"
              strokeWidth="1"
              strokeDasharray="3, 3"
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Markers */}
          {data.map((d, idx) => {
            const cx = getX(idx);
            const isHovered = hoveredPoint && hoveredPoint.idx === idx;
            const isCurrentActive = isSceneActive(d.scene_id);

            return (
              <g key={idx}>
                {/* Min Markers */}
                {showMin && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.min)} 
                    r={isHovered ? "5.5" : "3.5"} 
                    fill="#a5a5a5" 
                    stroke="#ffffff" 
                    strokeWidth="1.2"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Max Markers */}
                {showMax && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.max)} 
                    r={isHovered ? "5.5" : "3.5"} 
                    fill="#ed7d31" 
                    stroke="#ffffff" 
                    strokeWidth="1.2"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Mean Markers */}
                {showMean && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.mean)} 
                    r={isHovered ? "5.5" : "3.5"} 
                    fill="#4472c4" 
                    stroke="#ffffff" 
                    strokeWidth="1.2"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Active Overlay pulsing ring */}
                {isCurrentActive && showMean && (
                  <circle 
                    cx={cx} 
                    cy={getY(d.mean)} 
                    r="8" 
                    fill="none" 
                    stroke="#4472c4" 
                    strokeWidth="1.5" 
                    strokeDasharray="2, 2"
                    className="excel-pulse-ring"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
              </g>
            );
          })}

          {/* Mouse Scrubber Overlay Capture Box */}
          <rect
            x={paddingLeft}
            y={paddingTop}
            width={chartWidth}
            height={chartHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{ cursor: 'crosshair' }}
          />
        </svg>

        {/* Excel Tooltip */}
        {hoveredPoint && (
          <div 
            className="excel-tooltip"
            style={{ 
              left: tooltipPos.x > width * 0.5 ? `${tooltipPos.x - 170}px` : `${tooltipPos.x + 15}px`,
              top: `${tooltipPos.y - 15}px`
            }}
          >
            <div className="excel-tooltip-date">{hoveredPoint.date}</div>
            <div className="excel-tooltip-grid">
              {showMean && (
                <div className="flex justify-between gap-4">
                  <span style={{ color: '#4472c4', fontWeight: 'bold' }}>Mean:</span>
                  <span className="font-bold">{hoveredPoint.mean.toFixed(4)}</span>
                </div>
              )}
              {showMax && (
                <div className="flex justify-between gap-4">
                  <span style={{ color: '#ed7d31', fontWeight: 'bold' }}>Max:</span>
                  <span className="font-bold">{hoveredPoint.max.toFixed(4)}</span>
                </div>
              )}
              {showMin && (
                <div className="flex justify-between gap-4">
                  <span style={{ color: '#a5a5a5', fontWeight: 'bold' }}>Min:</span>
                  <span className="font-bold">{hoveredPoint.min.toFixed(4)}</span>
                </div>
              )}
              <div className="flex justify-between gap-4 border-t border-slate-200 mt-1 pt-1 text-[10px] text-slate-500">
                <span>Cloud:</span>
                <span>{hoveredPoint.cloud_cover.toFixed(1)}%</span>
              </div>
              {isSceneActive(hoveredPoint.scene_id) && (
                <div className="text-[9px] font-bold mt-1 text-center text-blue-600 uppercase">
                  ★ Active Map Overlay
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* CSV Export & Actions bar */}
      <div className="flex justify-between items-center mt-3 pt-2 border-t border-slate-200">
        <span className="text-[10px] text-slate-500 font-bold">
          Total: {data.length} Dates
        </span>
        <button 
          onClick={handleExportCSV} 
          className="excel-btn"
        >
          Export CSV
        </button>
      </div>

      {/* Mini data table */}
      <div className="mt-3 overflow-y-auto max-h-[140px] border border-slate-200 rounded">
        <table className="excel-data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Mean</th>
              <th>Min/Max Range</th>
              <th>Cloud %</th>
              <th style={{ textAlign: 'center' }}>Map</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d, idx) => {
              // conditional formatting color code for cloud cover (Excel style green to red)
              let cloudStyle = { color: '#385723', fontWeight: 'bold' }; // Deep Excel Green
              if (d.cloud_cover > 15) cloudStyle = { color: '#c00000', fontWeight: 'bold' }; // Deep Excel Red
              else if (d.cloud_cover > 5) cloudStyle = { color: '#c65911', fontWeight: 'bold' }; // Excel Amber

              const isCurrentHovered = hoveredPoint && hoveredPoint.idx === idx;
              const isActiveScene = isSceneActive(d.scene_id);

              return (
                <tr 
                  key={idx}
                  style={{ 
                    backgroundColor: isActiveScene 
                      ? '#e6f0fa' 
                      : (isCurrentHovered ? '#f1f5f9' : 'transparent'),
                    transition: 'background-color 0.15s ease'
                  }}
                  onMouseEnter={() => setHoveredPoint({ ...d, idx })}
                  onMouseLeave={() => setHoveredPoint(null)}
                >
                  <td className="text-[10px] font-medium text-slate-600">{d.date}</td>
                  <td className="text-[10px] font-bold text-blue-700">{d.mean.toFixed(2)}</td>
                  <td className="text-[10px] text-slate-500">{d.min.toFixed(0)} / {d.max.toFixed(0)}</td>
                  <td className="text-[10px]" style={cloudStyle}>{d.cloud_cover.toFixed(0)}%</td>
                  <td className="text-center">
                    <button
                      onClick={() => onViewScene(d.scene_id, d.date)}
                      className={`text-[10px] px-2 py-0.5 rounded border ${isActiveScene ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'}`}
                    >
                      {isActiveScene ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// SVG Donut Chart
// LSM 5-class Viridis palette + labels, shared by the district donut and the
// highway-wise corridor analysis (class 0 = outside the model's study area).
const LSM_CLASS_COLORS = { 0: '#9ca3af', 1: '#440154', 2: '#3b528b', 3: '#21918c', 4: '#5ec962', 5: '#fde725' };
const LSM_CLASS_LABELS = { 0: 'Not Analysed', 1: 'Very Low', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Very High' };

function DonutChart({ stats, analyzedPercent = 72, centerLabel = 'Area Analyzed' }) {
  const data = [
    { label: 'Very High', value: stats['5'] !== undefined ? stats['5'] : 12.4, color: '#fde725' },
    { label: 'High', value: stats['4'] !== undefined ? stats['4'] : 18.7, color: '#5ec962' },
    { label: 'Moderate', value: stats['3'] !== undefined ? stats['3'] : 24.1, color: '#21918c' },
    { label: 'Low', value: stats['2'] !== undefined ? stats['2'] : 28.6, color: '#3b528b' },
    { label: 'Very Low', value: stats['1'] !== undefined ? stats['1'] : 16.2, color: '#440154' }
  ];

  const total = data.reduce((sum, item) => sum + item.value, 0);
  let accumulatedPercent = 0;

  return (
    <div className="donut-wrapper">
      <div className="donut-chart">
        <svg viewBox="0 0 36 36" className="donut-svg">
          <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--border-color)" strokeWidth="3.2" />
          {data.map((item, idx) => {
            const percent = total > 0 ? (item.value / total) * 100 : 0;
            const dashArray = `${percent} ${100 - percent}`;
            const dashOffset = 100 - accumulatedPercent + 25; // start from top
            accumulatedPercent += percent;
            return (
              <circle
                key={idx}
                cx="18"
                cy="18"
                r="15.915"
                fill="none"
                stroke={item.color}
                strokeWidth="3.2"
                strokeDasharray={dashArray}
                strokeDashoffset={dashOffset}
              />
            );
          })}
        </svg>
        <div className="donut-text">
          <span className="donut-val">{analyzedPercent}%</span>
          <span className="donut-lbl">{centerLabel}</span>
        </div>
      </div>
      <div className="donut-legend">
        {data.map((item, idx) => (
          <div key={idx} className="donut-legend-item">
            <span className="bullet" style={{ backgroundColor: item.color }}></span>
            <span className="lbl">{item.label}</span>
            <span className="val">{item.value.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Variable-category distribution donut (Climate Anomaly Atlas). Unlike
// DonutChart (LSM's fixed 5-class ring), the segment count/labels/colors here
// are fully data-driven, so it's a separate component rather than a DonutChart variant.
function CategoryDonut({ segments, centerValue, centerLabel }) {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  let accumulatedPercent = 0;
  const ranked = [...segments].sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 6);
  const restCount = ranked.slice(6).reduce((s, c) => s + c.count, 0);
  const restN = ranked.length - 6;

  return (
    <div className="donut-wrapper">
      <div className="donut-chart">
        <svg viewBox="0 0 36 36" className="donut-svg">
          <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--border-color)" strokeWidth="3.2" />
          {segments.map((s, idx) => {
            const percent = total > 0 ? (s.count / total) * 100 : 0;
            const dashArray = `${percent} ${100 - percent}`;
            const dashOffset = 100 - accumulatedPercent + 25;
            accumulatedPercent += percent;
            return (
              <circle key={idx} cx="18" cy="18" r="15.915" fill="none"
                stroke={s.color} strokeWidth="3.2"
                strokeDasharray={dashArray} strokeDashoffset={dashOffset} />
            );
          })}
        </svg>
        <div className="donut-text">
          <span className="donut-val">{centerValue}</span>
          <span className="donut-lbl">{centerLabel}</span>
        </div>
      </div>
      <div className="donut-legend">
        {top.map((s, idx) => (
          <div key={idx} className="donut-legend-item">
            <span className="bullet" style={{ backgroundColor: s.color }}></span>
            <span className="lbl">{s.key}</span>
            <span className="val">{total ? (s.count / total * 100).toFixed(0) : 0}%</span>
          </div>
        ))}
        {restN > 0 && (
          <div className="donut-legend-item">
            <span className="lbl" style={{ color: 'var(--text-3)' }}>+ {restN} more</span>
            <span className="val">{total ? (restCount / total * 100).toFixed(0) : 0}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Small hand-rolled SVG line chart shared shell — straight-segment paths, a
// ResizeObserver-driven width and a hover-scrub tooltip, matching the
// conventions TimeSeriesChart already established (not reused directly since
// its data shape/interactions are specific to spectral-index results).
function useChartWidth() {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(300);
  useEffect(() => {
    if (!containerRef.current) return;
    const handleResize = () => {
      if (containerRef.current) setWidth(containerRef.current.clientWidth || 300);
    };
    handleResize();
    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  return [containerRef, width];
}

// Actual-vs-normal weekly trajectory for the selected Climate Anomaly Atlas district.
function ClimateTrendChart({ series, variable, year }) {
  const [containerRef, width] = useChartWidth();
  const [hover, setHover] = useState(null);

  if (!series || series.length === 0) {
    return <div className="chart-wrap" ref={containerRef} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: '11px' }}>No weekly data for {year}</div>;
  }

  const height = 200;
  const padL = 42, padR = 12, padT = 10, padB = 26;
  const chartW = Math.max(50, width - padL - padR);
  const chartH = height - padT - padB;

  const vals = [];
  series.forEach(r => {
    if (r.actualValue != null) vals.push(r.actualValue);
    if (r.normalValue != null) vals.push(r.normalValue);
  });
  let minY = vals.length ? Math.min(...vals) : 0;
  let maxY = vals.length ? Math.max(...vals) : 1;
  const range = maxY - minY || 1;
  minY -= range * 0.1;
  maxY += range * 0.1;

  const getX = i => series.length <= 1 ? padL + chartW / 2 : padL + (i / (series.length - 1)) * chartW;
  const getY = v => padT + chartH - ((v - minY) / (maxY - minY)) * chartH;

  const buildPath = key => series.map((r, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(r[key] ?? minY)}`).join(' ');
  const actualPath = buildPath('actualValue');
  const normalPath = buildPath('normalValue');

  const yTicks = [0, 1, 2, 3, 4].map(i => minY + (i / 4) * (maxY - minY));

  return (
    <div className="chart-wrap" ref={containerRef}>
      <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
        {yTicks.map((t, i) => (
          <line key={i} x1={padL} x2={padL + chartW} y1={getY(t)} y2={getY(t)} stroke="var(--border-soft)" strokeWidth="1" />
        ))}
        {yTicks.map((t, i) => (
          <text key={i} x={padL - 6} y={getY(t) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)">{t.toFixed(variable.id === 'rainfall' ? 0 : 1)}</text>
        ))}
        <path d={normalPath} fill="none" stroke="var(--text-3)" strokeWidth="1" strokeDasharray="4 4" />
        <path d={actualPath} fill="none" stroke="var(--accent-sky)" strokeWidth="1.8" />
        {series.map((r, i) => {
          const above = r.actualValue != null && r.normalValue != null && r.actualValue >= r.normalValue;
          const col = r.actualValue == null || r.normalValue == null ? 'var(--text-3)' : (above ? variable.surplusColor : variable.deficitColor);
          return (
            <circle key={i} cx={getX(i)} cy={getY(r.actualValue ?? minY)} r={hover === i ? 4 : 2.2}
              fill={col} stroke="var(--bg-card)" strokeWidth="1"
              onMouseEnter={() => setHover(i)} style={{ cursor: 'pointer' }} />
          );
        })}
        {series.map((r, i) => (
          <rect key={`hit-${i}`} x={getX(i) - (chartW / series.length) / 2} y={padT} width={Math.max(4, chartW / series.length)} height={chartH}
            fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover != null && series[hover] && (
        <div className="excel-tooltip" style={{ left: Math.min(width - 160, Math.max(0, getX(hover) - 70)), top: 4 }}>
          <div className="excel-tooltip-date">{series[hover].label}</div>
          <div className="excel-tooltip-grid">
            <span>Actual: {variable.formatActual(series[hover].actualValue)}</span>
            <span>Normal: {variable.formatNormal(series[hover].normalValue)}</span>
            <span>{variable.measureLabel}: {variable.formatMeasure(series[hover].measureValue)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Relative water-depth trend for the selected AWD plot — single filled line, no legend needed.
function AwdDepthChart({ dates, depthCm }) {
  const [containerRef, width] = useChartWidth();
  const [hover, setHover] = useState(null);

  if (!dates || dates.length === 0) {
    return <div className="chart-wrap" ref={containerRef} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: '11px' }}>No depth history</div>;
  }

  const height = 170;
  const padL = 34, padR = 10, padT = 10, padB = 22;
  const chartW = Math.max(50, width - padL - padR);
  const chartH = height - padT - padB;

  const vals = depthCm.filter(v => v != null);
  let minY = 0;
  let maxY = Math.max(15, ...(vals.length ? vals : [15]));

  const getX = i => dates.length <= 1 ? padL + chartW / 2 : padL + (i / (dates.length - 1)) * chartW;
  const getY = v => padT + chartH - ((v - minY) / (maxY - minY || 1)) * chartH;

  const linePath = depthCm.map((v, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(v ?? 0)}`).join(' ');
  const areaPath = `${linePath} L ${getX(dates.length - 1)} ${getY(0)} L ${getX(0)} ${getY(0)} Z`;

  return (
    <div className="chart-wrap" ref={containerRef}>
      <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
        <path d={areaPath} fill="var(--teal-tint)" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--accent-sky)" strokeWidth="1.8" />
        {depthCm.map((v, i) => (
          <circle key={i} cx={getX(i)} cy={getY(v ?? 0)} r={hover === i ? 4 : 2}
            fill="var(--accent-sky)" stroke="var(--bg-card)" strokeWidth="1"
            onMouseEnter={() => setHover(i)} style={{ cursor: 'pointer' }} />
        ))}
        {dates.map((d, i) => (
          <rect key={`hit-${i}`} x={getX(i) - (chartW / dates.length) / 2} y={padT} width={Math.max(4, chartW / dates.length)} height={chartH}
            fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover != null && (
        <div className="excel-tooltip" style={{ left: Math.min(width - 140, Math.max(0, getX(hover) - 60)), top: 4 }}>
          <div className="excel-tooltip-date">{climateFmtDate(dates[hover])}</div>
          <div className="excel-tooltip-grid">
            <span>Depth: {(depthCm[hover] ?? 0).toFixed(1)} cm</span>
          </div>
        </div>
      )}
    </div>
  );
}

// cache of fetched velocity value arrays: id -> Float32Array
const defBinCache = new Map();

async function getDefValues(layer) {
  if (!defBinCache.has(layer.id)) {
    const response = await fetch(`${import.meta.env.BASE_URL}velocity_data/${layer.bin}`);
    const buf = await response.arrayBuffer();
    defBinCache.set(layer.id, new Float32Array(buf));
  }
  return defBinCache.get(layer.id);
}

// value at a lat/lng from a layer's native-resolution grid; null if outside or no-data
async function queryDefLayer(layer, lat, lng) {
  const [[south, west], [north, east]] = layer.bounds;
  if (lat < south || lat > north || lng < west || lng > east) return null;
  const values = await getDefValues(layer);
  const row = Math.min(layer.height - 1, Math.floor(((north - lat) / (north - south)) * layer.height));
  const col = Math.min(layer.width - 1, Math.floor(((lng - west) / (east - west)) * layer.width));
  const v = values[row * layer.width + col];
  return Number.isFinite(v) ? v : null;
}

const LOAD_STAGES = ["Connecting to STAC", "Fetching COG tiles", "Processing raster", "Rendering output"];

// ===========================================================
// Climate Anomaly Atlas — config (ported from cweb/app.js)
// ===========================================================

const RAINFALL_CATS = [
  { key: "Excess",    color: "#60b1f4", range: ">+20%"        },
  { key: "Normal",    color: "#6ae944", range: "-19% to +20%" },
  { key: "Deficient", color: "#dd7534", range: "-20% to -59%" },
  { key: "Scanty",    color: "#ffe23a", range: "-60% to -99%" },
  { key: "No Rain",   color: "#969696", range: "≤ -99%"       },
  { key: "No Data",   color: "#E9EDF0", range: "—"            },
];

const TEMP_CATS = [
  { key: "< -5",     color: "#004da8", range: "< -5 °C"     },
  { key: "-5 to -4", color: "#0536fe", range: "-5 to -4 °C" },
  { key: "-4 to -3", color: "#618cd3", range: "-4 to -3 °C" },
  { key: "-3 to -2", color: "#0a8500", range: "-3 to -2 °C" },
  { key: "-2 to -1", color: "#17dd05", range: "-2 to -1 °C" },
  { key: "-1 to 0",  color: "#b8edae", range: "-1 to 0 °C"  },
  { key: "0 to 1",   color: "#f6f69c", range: "0 to +1 °C"  },
  { key: "1 to 2",   color: "#f9f904", range: "+1 to +2 °C" },
  { key: "2 to 3",   color: "#f7ad00", range: "+2 to +3 °C" },
  { key: "3 to 4",   color: "#ff9b9b", range: "+3 to +4 °C" },
  { key: "4 to 5",   color: "#ff0000", range: "+4 to +5 °C" },
  { key: "> 5",      color: "#600700", range: "> +5 °C"     },
  { key: "No Data",  color: "#E9EDF0", range: "—"           },
];

const TEMP_SURPLUS = new Set(["0 to 1", "1 to 2", "2 to 3", "3 to 4", "4 to 5", "> 5"]);
const TEMP_DEFICIT = new Set(["< -5", "-5 to -4", "-4 to -3", "-3 to -2", "-2 to -1", "-1 to 0"]);

const CLIMATE_VARIABLES = {
  rainfall: {
    id: "rainfall", label: "Rainfall deviation",
    dataBase: `${import.meta.env.BASE_URL}climate/rainfall`, categories: RAINFALL_CATS,
    fields: { actual: "actual", normal: "normal", measure: "deviation", category: "category" },
    units: { actual: "mm", normal: "mm", measure: "%" },
    measureLabel: "Deviation",
    formatMeasure: v => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(1) + "%"),
    formatActual: v => v == null ? "—" : Number(v).toFixed(1) + " mm",
    formatNormal: v => v == null ? "—" : Number(v).toFixed(1) + " mm",
    surplusKeys: new Set(["Excess"]),
    deficitKeys: new Set(["Deficient", "Scanty", "No Rain"]),
    hero: { surplusLabel: "Surplus", surplusUnit: "excess districts",
            deficitLabel: "Deficit", deficitUnit: "deficient + scanty + no-rain" },
    surplusColor: "#60b1f4", deficitColor: "#dd7534",
    legendTitle: "Rainfall departure classes",
    normalNote: "Normal rainfall considered from 1961–2010",
    yAxisUnit: "mm",
  },
  tmax: {
    id: "tmax", label: "Max-temperature anomaly",
    dataBase: `${import.meta.env.BASE_URL}climate/temperature`, categories: TEMP_CATS,
    fields: { actual: "tmax_actual", normal: "tmax_normal", measure: "tmax_anomaly", category: "tmax_category" },
    units: { actual: "°C", normal: "°C", measure: "°C" },
    measureLabel: "Anomaly",
    formatMeasure: v => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "°C"),
    formatActual: v => v == null ? "—" : Number(v).toFixed(1) + " °C",
    formatNormal: v => v == null ? "—" : Number(v).toFixed(1) + " °C",
    surplusKeys: TEMP_SURPLUS, deficitKeys: TEMP_DEFICIT,
    hero: { surplusLabel: "Warmer", surplusUnit: "districts above normal",
            deficitLabel: "Cooler", deficitUnit: "districts below normal" },
    surplusColor: "#ff0000", deficitColor: "#0536fe",
    legendTitle: "Max-temp anomaly classes",
    normalNote: "Max-temp anomaly w.r.t average of 2016–2024",
    yAxisUnit: "°C",
  },
  tmin: {
    id: "tmin", label: "Min-temperature anomaly",
    dataBase: `${import.meta.env.BASE_URL}climate/temperature`, categories: TEMP_CATS,
    fields: { actual: "tmin_actual", normal: "tmin_normal", measure: "tmin_anomaly", category: "tmin_category" },
    units: { actual: "°C", normal: "°C", measure: "°C" },
    measureLabel: "Anomaly",
    formatMeasure: v => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "°C"),
    formatActual: v => v == null ? "—" : Number(v).toFixed(1) + " °C",
    formatNormal: v => v == null ? "—" : Number(v).toFixed(1) + " °C",
    surplusKeys: TEMP_SURPLUS, deficitKeys: TEMP_DEFICIT,
    hero: { surplusLabel: "Warmer", surplusUnit: "districts above normal",
            deficitLabel: "Cooler", deficitUnit: "districts below normal" },
    surplusColor: "#ff0000", deficitColor: "#0536fe",
    legendTitle: "Min-temp anomaly classes",
    normalNote: "Min-temp anomaly w.r.t average of 2016–2024",
    yAxisUnit: "°C",
  },
};

const CLIMATE_MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

const CLIMATE_DISTRICT_KEY = "dtname";
const CLIMATE_STATE_KEY = "stname";
const CLIMATE_SEP = "␟"; // composite key separator (name ␟ state)
const climateLK = (name, st) => `${name}${CLIMATE_SEP}${st}`;

const CLIMATE_IMPORTANT_DISTRICTS_LC = new Set([
  "bangalore urban", "bengaluru urban", "bengaluru",
  "mumbai city", "mumbai suburban", "mumbai",
  "chennai", "kolkata", "hyderabad",
  "lucknow", "jaipur", "bhopal", "patna",
  "thiruvananthapuram", "tiruvananthapuram",
  "ahmedabad", "pune", "surat", "kanpur nagar", "kanpur",
  "nagpur", "indore", "vadodara", "visakhapatnam", "coimbatore",
  "agra", "varanasi", "meerut", "ludhiana", "amritsar",
  "faridabad", "gurgaon", "gurugram", "ranchi", "raipur",
  "bhubaneswar", "khordha", "khurda", "cuttack",
  "dehradun", "srinagar", "shimla", "gandhinagar",
  "imphal", "imphal west", "aizawl", "kohima",
  "itanagar", "papum pare", "gangtok", "east sikkim",
  "shillong", "east khasi hills", "agartala", "west tripura",
  "panaji", "north goa", "kamrup metropolitan", "jammu", "chandigarh",
  "new delhi", "central delhi", "south delhi", "north delhi",
  "east delhi", "west delhi", "north east delhi", "south west delhi",
  "rajkot", "nashik", "aurangabad", "madurai", "mysuru", "mysore",
  "tiruchirappalli", "salem", "vellore",
  "mangaluru", "mangalore", "thane", "kolhapur",
  "puducherry", "pondicherry",
]);

function climateCatColor(varId, catKey) {
  const cats = CLIMATE_VARIABLES[varId].categories;
  const found = cats.find(c => c.key === catKey);
  return found ? found.color : cats[cats.length - 1].color;
}

function climateFmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function climateTitleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function climateContrastText(hex) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0,2),16), g = parseInt(m.slice(2,4),16), b = parseInt(m.slice(4,6),16);
  return (0.2126*r + 0.7152*g + 0.0722*b) / 255 > 0.6 ? "#212B36" : "#ffffff";
}

// ===========================================================
// AWD & Flooding Plots — config (ported from cweb/app.js)
// ===========================================================

const AWD_RAMPS = {
  blue:   ['#deebf7','#9ecae1','#4292c6','#2171b5','#08519c','#08306b'],
  teal:   ['#d5efed','#99d8d0','#41b6a6','#1d8f86','#0c6b66','#034e4a'],
  orange: ['#feedde','#fdbe85','#fd8d3c','#e6550d','#a63603','#7f2704'],
  purple: ['#efedf5','#bcbddc','#9e9ac8','#756bb1','#54278f','#3f007d'],
  green:  ['#e5f5e0','#a1d99b','#74c476','#41ab5d','#238b45','#005a32'],
  grey:   ['#f0f0f0','#d9d9d9','#bdbdbd','#969696','#636363','#252525'],
};

function awdQuantiles(vals, n) {
  const v = vals.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return [];
  const qs = [];
  for (let i = 1; i < n; i++) {
    qs.push(v[Math.floor(i / n * v.length)]);
  }
  return qs;
}

function awdColorFor(varDef, val) {
  if (!varDef) return '#bdbdbd';
  if (varDef.type === 'cat') return varDef.cats[val] || '#bdbdbd';
  if (val == null) return '#444b54';
  let i = 0;
  while (i < varDef.breaks.length && val > varDef.breaks[i]) i++;
  return varDef.colors[i];
}

const AWD_METRIC_ORDER = ['sown','method','parea','initial','total','wet','dry','season','rain','awd','avgdepth','depthvar','auc','swater'];
const AWD_DAY_KEYS = new Set(['total','wet','dry','rain','initial','season']);

function App() {
  // Navigation tabs
  const [activeTab, setActiveTab] = useState("Spectral Monitor");
  const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);
  const modeDropdownRef = useRef(null);

  // --- LSM View States ---
  const [lsmSelectedState, setLsmSelectedState] = useState('');
  const [lsmDistrictsData, setLsmDistrictsData] = useState([]);
  const [lsmPrecomputedStats, setLsmPrecomputedStats] = useState({});
  const [lsmTempDistrict, setLsmTempDistrict] = useState('');
  const [lsmSelectedDistrict, setLsmSelectedDistrict] = useState(null);
  const [lsmDistrictStats, setLsmDistrictStats] = useState({ '1': 12.9, '2': 24.2, '3': 27.0, '4': 35.9, '5': 0.0 });
  const [lsmAnalyzedPercent, setLsmAnalyzedPercent] = useState(70);
  const [lsmProbabilityStats, setLsmProbabilityStats] = useState(null);
  const [activeLsmOverlay, setActiveLsmOverlay] = useState('probability'); // 'probability' | 'classes' | 'none'
  const [lsmDistrictGeoJson, setLsmDistrictGeoJson] = useState(null);
  const [lsmPopupCoords, setLsmPopupCoords] = useState(null);
  const [showLsmLayersDropdown, setShowLsmLayersDropdown] = useState(false);

  // --- Shared "National Highways" overlay (available for every feature/tool) ---
  const [showHighways, setShowHighways] = useState(false);
  const [highwaysGeoJson, setHighwaysGeoJson] = useState(null);
  const highwaysLayerRef = useRef(null);

  // --- LSM National Highway-wise analysis states ---
  const [lsmFocusType, setLsmFocusType] = useState('district'); // 'district' | 'highway'
  const [lsmHighwayStatsData, setLsmHighwayStatsData] = useState(null); // highway_stats.json rows
  const [lsmHighwayFilter, setLsmHighwayFilter] = useState('');
  const [lsmTempHighway, setLsmTempHighway] = useState('');
  const [lsmBufferM, setLsmBufferM] = useState('500'); // corridor buffer in metres (each side)
  const [lsmSelectedHighway, setLsmSelectedHighway] = useState(null); // stats row (precomputed or live)
  const [lsmHighwaySegments, setLsmHighwaySegments] = useState(null); // { segments, buffer_polygons }
  const [lsmHighwayLoading, setLsmHighwayLoading] = useState(false);

  // Refs for LSM leaflet layers
  const lsmOverlayLayerRef = useRef(null);
  const lsmDistrictBoundaryLayerRef = useRef(null);
  const lsmHighwayLayerRef = useRef(null);
  const lsmHighwayFlownRef = useRef(null); // last highway flown to (skip re-fly on buffer change)
  const lsmPopupRef = useRef(null);

  // --- Deformation Mode View States ---
  const [defManifest, setDefManifest] = useState(null);
  const [defIndiaGeoJson, setDefIndiaGeoJson] = useState(null);
  const [defSelectedState, setDefSelectedState] = useState('');
  const [defVisibleLayers, setDefVisibleLayers] = useState(new Set(['asc', 'dsc']));
  const [defQuery, setDefQuery] = useState(null);
  const [defOpacity, setDefOpacity] = useState(1.0);

  // Refs for Deformation Mode Leaflet layers
  const defOverlaysRef = useRef(new Map()); // id -> L.imageOverlay
  const defClickMarkerRef = useRef(null);
  const defStateHighlightRef = useRef(null);
  const defBoundariesLayerRef = useRef(null);
  const defPopupRef = useRef(null);

  // --- Climate Anomaly Atlas view state ---
  const [climateVar, setClimateVar] = useState("rainfall"); // "rainfall" | "tmax" | "tmin"
  const [climateSources, setClimateSources] = useState({}); // { rainfall: {manifest, weeksByKey, weekCache}, temperature: {...} }
  const [climateYear, setClimateYear] = useState(null);
  const [climateMonth, setClimateMonth] = useState(null);
  const [climateWeek, setClimateWeek] = useState(null);
  const [climateWeekData, setClimateWeekData] = useState(null);
  const [climateDistrictsGeoJson, setClimateDistrictsGeoJson] = useState(null);
  const [climateTimeseriesCache, setClimateTimeseriesCache] = useState({}); // { rainfall: obj|null, temperature: obj|null }
  const [climateStateFilter, setClimateStateFilter] = useState("");
  const [climateSelectedDistrict, setClimateSelectedDistrict] = useState(null);
  const [climateSelectedState, setClimateSelectedState] = useState(null);
  const [climateLoadError, setClimateLoadError] = useState("");

  // Refs for Climate Leaflet layers / lookups
  const climateGeoLayerRef = useRef(null);
  const climateDistrictLayerMapRef = useRef(new Map()); // "name␟state" -> layer
  const climateLayersByNameRef = useRef(new Map());     // name -> [{state, layer}]
  const climateSelectedLayerRef = useRef(null);
  const climateHoveredLayerRef = useRef(null);           // guards against missed mouseout events on dense polygon clusters
  const climateLabelsRef = useRef(new Map());           // "name␟state" -> {name, latlng, area, isImportant, marker}
  const climateSelectedLabelRef = useRef(null);
  const climateLabelFrameRef = useRef(null);
  const climateLightTilesRef = useRef(null);

  // --- AWD & Flooding Plots view state ---
  const [awdData, setAwdData] = useState(null); // { geojson, dates, depth, rwdiToCm, varDefs (augmented), varByKey }
  const [awdColorByKey, setAwdColorByKey] = useState("total");
  const [awdSelectedFid, setAwdSelectedFid] = useState(null);
  const [awdSearchText, setAwdSearchText] = useState("");
  const [awdSearchMsg, setAwdSearchMsg] = useState(null); // { text, isError }
  const [awdLoadError, setAwdLoadError] = useState("");

  // Refs for AWD Leaflet layers / lookups
  const awdGeoLayerRef = useRef(null);
  const awdFidLayerRef = useRef({});
  const awdSelectedLayerRef = useRef(null);
  const awdFlashTimerRef = useRef(null);

  const sanitizeLsmFilename = (name) => {
    return String(name).replace(/[^a-zA-Z0-9]/g, '_');
  };

  // Region of Interest (ROI) State
  const [minLon, setMinLon] = useState(78.900000);
  const [minLat, setMinLat] = useState(20.500000);
  const [maxLon, setMaxLon] = useState(79.050000);
  const [maxLat, setMaxLat] = useState(20.650000);
  const [roiMethod, setRoiMethod] = useState("file"); // "file" | "draw"
  const [pointLat, setPointLat] = useState(20.575018);
  const [pointLon, setPointLon] = useState(78.975000);
  const [pointRadius, setPointRadius] = useState(5000); // meters
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [uploadedGeoJson, setUploadedGeoJson] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawVertices, setDrawVertices] = useState([]);
  const drawVerticesRef = useRef([]);
  const drawLineRef = useRef(null);
  const firstVertexMarkerRef = useRef(null); // Ref to closing circle marker

  // Satellite search state
  const [platform, setPlatform] = useState("Sentinel-2 (Optical)");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [cloudCover, setCloudCover] = useState(12);
  const [orbit, setOrbit] = useState("BOTH");

  // STAC search items
  const [scenes, setScenes] = useState([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSceneMeta, setSelectedSceneMeta] = useState(null);
  const [showRoiPopup, setShowRoiPopup] = useState(false);
  const [showScenePopup, setShowScenePopup] = useState(false);
  const [showModePopup, setShowModePopup] = useState(false);
  const [showSettingsPopup, setShowSettingsPopup] = useState(false);

  // --- Spectral Monitor State ---
  const [spectralIndex, setSpectralIndex] = useState("NDVI");
  const [customFormula, setCustomFormula] = useState("(B8 - B4) / (B8 + B4)");
  const [colorPalette, setColorPalette] = useState("Red-Yellow-Green (Vegetation)");
  const [visMin, setVisMin] = useState("0.009");
  const [visMax, setVisMax] = useState("0.657");
  const [spectralResult, setSpectralResult] = useState(null);

  // Time Series Analysis States
  const [analysisMode, setAnalysisMode] = useState("single"); // "single" | "timeseries" | "lulc"
  const [timeSeriesResult, setTimeSeriesResult] = useState(null);
  const [maxScenes, setMaxScenes] = useState(15);
  const [timeSeriesLoading, setTimeSeriesLoading] = useState(false);

  // LULC Mapping States
  const [lulcDataset, setLulcDataset] = useState("esa-worldcover");
  const [lulcYear, setLulcYear] = useState(2021);
  const [lulcResult, setLulcResult] = useState(null);
  const [lulcLoading, setLulcLoading] = useState(false);

  // AEF AI Clustering States
  const [aefYear, setAefYear] = useState(2024);
  const [aefClusters, setAefClusters] = useState(5);
  const [aefResult, setAefResult] = useState(null);
  const [aefLoading, setAefLoading] = useState(false);
  const [customClusterNames, setCustomClusterNames] = useState({});

  // AEF AI Similarity States
  const [queryGeometry, setQueryGeometry] = useState(null);
  const [queryFileName, setQueryFileName] = useState("");
  const [drawingTarget, setDrawingTarget] = useState("roi"); // "roi" | "query"
  const [aefSimMode, setAefSimMode] = useState("centered"); // "centered" | "dotproduct"
  const [aefThreshold, setAefThreshold] = useState(0.5);
  const [similarityResult, setSimilarityResult] = useState(null);
  const [similarityLoading, setSimilarityLoading] = useState(false);

  // Flood Detection States (Sentinel-1 SAR backscatter change)
  // Defaults mirror flood.py's Hadgaon reference event (~30 Sep 2025).
  const [floodPreStart, setFloodPreStart] = useState("2025-09-01");
  const [floodPreEnd, setFloodPreEnd] = useState("2025-09-29");
  const [floodPostStart, setFloodPostStart] = useState("2025-09-30");
  const [floodPostEnd, setFloodPostEnd] = useState("2025-10-12");
  const [floodOrbit, setFloodOrbit] = useState("descending");
  const [floodThreshold, setFloodThreshold] = useState(3.0);
  const [floodResult, setFloodResult] = useState(null);
  const [floodLoading, setFloodLoading] = useState(false);
  // Vertical swipe divider on the map: fraction (0..1) of map width. LEFT of the
  // divider shows the POST-event scene, RIGHT shows the PRE-event scene.
  const [floodSwipeX, setFloodSwipeX] = useState(0.5);
  const floodSwipeXRef = useRef(0.5);
  const [floodSwipeDragging, setFloodSwipeDragging] = useState(false);
  const [floodShowMask, setFloodShowMask] = useState(true);

  // Evapotranspiration (SEBAL) States — Landsat-9 + ERA5-Land (CDS).
  // analysisMode "et" = single-date map, "et_timeseries" = seasonal trend.
  const [etSingleResult, setEtSingleResult] = useState(null);
  const [etSeriesResult, setEtSeriesResult] = useState(null);
  const [etLoading, setEtLoading] = useState(false);
  const [etMaxScenes, setEtMaxScenes] = useState(6);      // hard-capped at 8 server-side
  const [etPalette, setEtPalette] = useState("ET (Dry-Wet)");
  const [etVisMin, setEtVisMin] = useState("");
  const [etVisMax, setEtVisMax] = useState("");

  // Dynamic Overlay Resize states
  const [resultsWidth, setResultsWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = (mouseDownEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const newWidth = window.innerWidth - e.clientX;
      // Constrain sidebar panel width between 300px and 600px
      if (newWidth >= 300 && newWidth <= 600) {
        setResultsWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);


  // App UI states
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [loadingStage, setLoadingStage] = useState(0);
  const [toast, setToast] = useState(null);
  const [baseMap, setBaseMap] = useState("satellite");
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme_pref') || 'light'; } catch (e) { return 'light'; }
  });
  const [hoverCoords, setHoverCoords] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [searchCoords, setSearchCoords] = useState("");
  const [overlayOpacity, setOverlayOpacity] = useState(1.0);
  const [resultsPanelOpen, setResultsPanelOpen] = useState(false);

  // Map references
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const roiLayerRef = useRef(null);
  const imageOverlayRef = useRef(null);
  const floodBeforeOverlayRef = useRef(null);
  const floodAfterOverlayRef = useRef(null);
  const floodMaskOverlayRef = useRef(null);
  const baseTilesRef = useRef(null);
  const geoJsonLayerRef = useRef(null);
  const queryLayerRef = useRef(null);

  // Sync drawVertices state with ref
  useEffect(() => {
    drawVerticesRef.current = drawVertices;
  }, [drawVertices]);

  // Advance the loading-overlay stage indicators over time. There's no
  // real progress stream from the backend, so this simulates a plausible
  // STAC -> COG fetch -> raster processing -> render sequence and caps at
  // the last stage until the request actually resolves.
  useEffect(() => {
    if (!loading) { setLoadingStage(0); return; }
    setLoadingStage(0);
    const timers = [
      setTimeout(() => setLoadingStage(1), 1000),
      setTimeout(() => setLoadingStage(2), 3200),
      setTimeout(() => setLoadingStage(3), 6500),
    ];
    return () => timers.forEach(clearTimeout);
  }, [loading]);

  // Apply + persist the active color theme (dark / light)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme_pref", theme);
    } catch (e) {
      /* ignore storage errors */
    }
  }, [theme]);

  // Load LSM districts data and precomputed stats on mount
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}districts.json`)
      .then(res => res.json())
      .then(data => setLsmDistrictsData(data))
      .catch(err => console.error("Error loading LSM districts:", err));

    fetch(`${import.meta.env.BASE_URL}district_stats.json`)
      .then(res => res.json())
      .then(data => {
        const lookup = {};
        data.forEach(item => {
          lookup[`${item.state}_${item.district}`] = item;
        });
        setLsmPrecomputedStats(lookup);
      })
      .catch(err => console.error("Error loading LSM precomputed stats:", err));
  }, []);

  // Get unique LSM states
  const lsmStates = useMemo(() => {
    const s = new Set(lsmDistrictsData.map(d => d.state));
    return Array.from(s).sort();
  }, [lsmDistrictsData]);

  // Get LSM districts for selected state
  const lsmDistrictsInState = useMemo(() => {
    if (!lsmSelectedState) return [];
    return lsmDistrictsData.filter(d => d.state === lsmSelectedState);
  }, [lsmDistrictsData, lsmSelectedState]);

  // Load precomputed highway LSM stats the first time highway analysis is opened
  useEffect(() => {
    if (analysisMode !== 'lsm' || lsmFocusType !== 'highway' || lsmHighwayStatsData) return;
    fetch(`${import.meta.env.BASE_URL}highway_stats.json`)
      .then(res => res.json())
      .then(data => setLsmHighwayStatsData(data))
      .catch(err => {
        console.error('Error loading highway LSM stats:', err);
        setLsmHighwayStatsData([]);
      });
  }, [analysisMode, lsmFocusType, lsmHighwayStatsData]);

  // Highway dropdown options — filtered, naturally sorted, grouped NH vs other
  const lsmHighwayOptions = useMemo(() => {
    if (!lsmHighwayStatsData) return null;
    const q = lsmHighwayFilter.trim().toLowerCase();
    const matches = lsmHighwayStatsData.filter(h => h.name && (!q || h.name.toLowerCase().includes(q)));
    const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return {
      nh: matches.filter(h => /^NH\b/i.test(h.name)).sort(cmp),
      other: matches.filter(h => !/^NH\b/i.test(h.name)).sort(cmp),
    };
  }, [lsmHighwayStatsData, lsmHighwayFilter]);

  // Handle LSM map interactions, overlays and listeners
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (analysisMode === "lsm") {
      // (double-click-to-zoom is disabled centrally for all query-on-dblclick modes, see below)

      // Zoom to India initially with a small delay to let the DOM settle
      const timer = setTimeout(() => {
        map.invalidateSize();
        map.fitBounds([
          [7.874581612284692, 68.6315],
          [37.0005, 97.2604328483906]
        ]);
      }, 100);

      // Add double click listener for query popup
      const onMapDblClick = (e) => {
        const { lat, lng } = e.latlng;
        setLsmPopupCoords({ lat, lng, loading: true });

        // Open a Leaflet popup at coordinates
        const popup = L.popup({ className: 'custom-popup' })
          .setLatLng([lat, lng])
          .setContent(`
            <div class="popup-container">
              <div class="popup-header">
                <svg class="popup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; display: inline-block;">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                <h4>Coordinate Query</h4>
              </div>
              <div class="popup-coordinates">
                ${lat.toFixed(5)}° N, ${lng.toFixed(5)}° E
              </div>
              <hr class="popup-divider" />
              <div class="popup-loading">
                <div class="skeleton-bar"></div>
                <div class="skeleton-bar narrow"></div>
              </div>
            </div>
          `)
          .openOn(map);

        lsmPopupRef.current = popup;

        fetch(`${API_BASE}/api/probability?lat=${lat}&lon=${lng}`)
          .then(async res => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || "LSM probability query failed");
            return data;
          })
          .then(data => {
            if (!popup.isOpen()) return;

            let content = '';
            if (data.probability !== null && data.probability !== undefined) {
              const val = data.probability;
              let badgeClass = 'badge-verylow';
              let badgeText = 'Very Low';
              if (val >= 0.8) { badgeClass = 'badge-veryhigh'; badgeText = 'Very High'; }
              else if (val >= 0.6) { badgeClass = 'badge-high'; badgeText = 'High'; }
              else if (val >= 0.4) { badgeClass = 'badge-medium'; badgeText = 'Medium'; }
              else if (val >= 0.2) { badgeClass = 'badge-low'; badgeText = 'Low'; }

              content = `
                <div class="popup-result">
                  <div class="result-label">Susceptibility Value</div>
                  <div class="result-value">${val.toFixed(4)}</div>
                  <div class="result-badge-container">
                    <span class="result-badge ${badgeClass}">${badgeText}</span>
                  </div>
                </div>
              `;
            } else {
              content = `<div class="popup-no-data">Outside Study Boundary</div>`;
            }

            popup.setContent(`
              <div class="popup-container">
                <div class="popup-header">
                  <svg class="popup-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; display: inline-block;">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                  <h4>Coordinate Query</h4>
                </div>
                <div class="popup-coordinates">
                  ${lat.toFixed(5)}° N, ${lng.toFixed(5)}° E
                </div>
                <hr class="popup-divider" />
                ${content}
              </div>
            `);
          })
          .catch(err => {
            if (!popup.isOpen()) return;
            popup.setContent(`
              <div class="popup-container">
                <div class="popup-header">
                  <h4>Coordinate Query</h4>
                </div>
                <hr class="popup-divider" />
                <div class="popup-error"><span>${err.message || "Database offline"}</span></div>
              </div>
            `);
          });
      };

      map.on('dblclick', onMapDblClick);

      // Clean up dblclick event listener on unmount / mode change
      return () => {
        clearTimeout(timer);
        map.off('dblclick', onMapDblClick);

        // Clear LSM map layers when leaving LSM mode
        if (lsmOverlayLayerRef.current) { map.removeLayer(lsmOverlayLayerRef.current); lsmOverlayLayerRef.current = null; }
        if (lsmDistrictBoundaryLayerRef.current) { map.removeLayer(lsmDistrictBoundaryLayerRef.current); lsmDistrictBoundaryLayerRef.current = null; }
        if (lsmHighwayLayerRef.current) { map.removeLayer(lsmHighwayLayerRef.current); lsmHighwayLayerRef.current = null; }
        if (lsmPopupRef.current) { map.closePopup(lsmPopupRef.current); lsmPopupRef.current = null; }
      };
    }
  }, [analysisMode]);

  // Handle LSM image overlay rendering
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "lsm") return;

    if (lsmOverlayLayerRef.current) {
      map.removeLayer(lsmOverlayLayerRef.current);
      lsmOverlayLayerRef.current = null;
    }

    if (activeLsmOverlay !== 'none') {
      const url = activeLsmOverlay === 'classes' ? `${import.meta.env.BASE_URL}lsm_map.png` : `${import.meta.env.BASE_URL}probability_map.png`;
      const bounds = [
        [7.874581612284692, 68.6315],
        [37.0005, 97.2604328483906]
      ];

      const overlay = L.imageOverlay(url, bounds, {
        opacity: overlayOpacity,
        interactive: false
      }).addTo(map);

      lsmOverlayLayerRef.current = overlay;
    }
  }, [analysisMode, activeLsmOverlay, overlayOpacity]);

  // National Highways overlay — available for every feature/tool, independent of analysisMode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (highwaysLayerRef.current) {
      map.removeLayer(highwaysLayerRef.current);
      highwaysLayerRef.current = null;
    }

    if (!showHighways) return;

    const addHighwaysLayer = (data) => {
      if (!mapRef.current) return;
      const layer = L.geoJSON(data, {
        style: {
          color: '#f97316',
          weight: 2,
          opacity: 0.85
        },
        onEachFeature: (feature, layer) => {
          if (feature.properties && feature.properties.Name) {
            layer.bindTooltip(feature.properties.Name, { sticky: true });
          }
        }
      }).addTo(mapRef.current);
      highwaysLayerRef.current = layer;
    };

    if (highwaysGeoJson) {
      addHighwaysLayer(highwaysGeoJson);
    } else {
      fetch(`${import.meta.env.BASE_URL}highways_overlay.json`)
        .then(res => res.json())
        .then(data => {
          setHighwaysGeoJson(data);
          if (showHighways) addHighwaysLayer(data);
        })
        .catch(err => console.error("Error loading highways:", err));
    }

    return () => {
      if (highwaysLayerRef.current && mapRef.current) {
        mapRef.current.removeLayer(highwaysLayerRef.current);
        highwaysLayerRef.current = null;
      }
    };
  }, [showHighways, highwaysGeoJson]);

  // Handle LSM selected district boundary rendering
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "lsm") return;

    if (lsmDistrictBoundaryLayerRef.current) {
      map.removeLayer(lsmDistrictBoundaryLayerRef.current);
      lsmDistrictBoundaryLayerRef.current = null;
    }

    if (lsmDistrictGeoJson && lsmSelectedDistrict) {
      const layer = L.geoJSON(lsmDistrictGeoJson, {
        style: {
          color: '#ef4444',
          weight: 3.5,
          fillColor: '#ef4444',
          fillOpacity: 0.04
        }
      }).addTo(map);

      lsmDistrictBoundaryLayerRef.current = layer;
      map.flyToBounds(layer.getBounds(), { duration: 1.5, padding: [40, 40] });
    }
  }, [analysisMode, lsmDistrictGeoJson, lsmSelectedDistrict]);

  // Handle LSM selected highway rendering: buffer corridor + class-coloured segments
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "lsm") return;

    if (lsmHighwayLayerRef.current) {
      map.removeLayer(lsmHighwayLayerRef.current);
      lsmHighwayLayerRef.current = null;
    }

    if (!lsmSelectedHighway || !lsmHighwaySegments) return;

    const group = L.layerGroup();

    const bufferGeom = lsmHighwaySegments.buffer_polygons && lsmHighwaySegments.buffer_polygons[String(lsmBufferM)];
    if (bufferGeom) {
      L.geoJSON({ type: 'Feature', properties: {}, geometry: bufferGeom }, {
        style: { color: '#94a3b8', weight: 1.2, dashArray: '4 4', fillColor: '#64748b', fillOpacity: 0.08 },
        interactive: false
      }).addTo(group);
    }

    (lsmHighwaySegments.segments || []).forEach(seg => {
      if (!seg.pts || seg.pts.length < 2) return;
      const isGap = seg.c === 0; // outside the susceptibility model's study area
      const line = L.polyline(seg.pts, {
        color: LSM_CLASS_COLORS[seg.c] || LSM_CLASS_COLORS[0],
        weight: isGap ? 2.5 : 5,
        opacity: isGap ? 0.5 : 0.95,
        dashArray: isGap ? '4 7' : null
      });
      line.bindTooltip(
        `${lsmSelectedHighway.name} — ${LSM_CLASS_LABELS[seg.c] || 'Unknown'} · ${seg.km} km`,
        { sticky: true }
      );
      line.addTo(group);
    });

    group.addTo(map);
    lsmHighwayLayerRef.current = group;

    if (lsmSelectedHighway.bounds && lsmHighwayFlownRef.current !== lsmSelectedHighway.name) {
      lsmHighwayFlownRef.current = lsmSelectedHighway.name;
      map.flyToBounds(lsmSelectedHighway.bounds, { duration: 1.5, padding: [40, 40] });
    }
  }, [analysisMode, lsmSelectedHighway, lsmHighwaySegments, lsmBufferM]);

  // Click outside to close LSM dropdown and Mode dropdown
  useEffect(() => {
    function handleClickOutside(event) {
      const dropdown = document.querySelector(".dropdown-parent");
      if (dropdown && !dropdown.contains(event.target)) {
        setShowLsmLayersDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(event.target)) {
        setIsModeDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // --- Deformation Mode Effects ---

  // Load manifest & state GeoJSON on demand when entering deformation mode
  useEffect(() => {
    if (analysisMode !== "deformation") return;
    if (!defManifest) {
      fetch(`${import.meta.env.BASE_URL}velocity_data/data/manifest.json`)
        .then((r) => r.json())
        .then(setDefManifest)
        .catch((err) => console.error('Could not load velocity manifest', err));
    }
    if (!defIndiaGeoJson) {
      fetch(`${import.meta.env.BASE_URL}velocity_data/data/india_states.geojson`)
        .then((r) => r.json())
        .then(setDefIndiaGeoJson)
        .catch((err) => console.error('Could not load india_states.geojson', err));
    }
  }, [analysisMode, defManifest, defIndiaGeoJson]);

  // Unique list of states for Deformation focus selection
  const defStates = useMemo(() => {
    if (!defIndiaGeoJson) return [];
    const names = defIndiaGeoJson.features
      .map((f) => f.properties.STNAME_SH || f.properties.STNAME)
      .filter(Boolean);
    return Array.from(new Set(names)).sort();
  }, [defIndiaGeoJson]);

  // Keep references of mutable variables accessed in map listener to bypass stale closures
  const defVisibleRef = useRef(defVisibleLayers);
  defVisibleRef.current = defVisibleLayers;
  
  const defManifestRef = useRef(defManifest);
  defManifestRef.current = defManifest;

  // Initialize Map for Deformation Mode, highlights, click listener
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "deformation" || !defManifest) return;

    // Zoom to union bounds initially
    if (defManifest.layers && defManifest.layers.length > 0) {
      let bounds = L.latLngBounds(defManifest.layers[0].bounds);
      for (const l of defManifest.layers) bounds.extend(L.latLngBounds(l.bounds));
      map.fitBounds(bounds.pad(0.02));
    }

    // Add boundaries to map
    let boundariesLayer = null;
    if (defIndiaGeoJson) {
      boundariesLayer = L.geoJSON(defIndiaGeoJson, {
        style: { color: '#ffd34d', weight: 1, fill: false, opacity: 0.25 },
        interactive: false,
      }).addTo(map);
      defBoundariesLayerRef.current = boundariesLayer;
    }

    // Map Click Query Listener
    const onMapClick = async (e) => {
      const { lat, lng } = e.latlng;
      if (defClickMarkerRef.current) map.removeLayer(defClickMarkerRef.current);
      defClickMarkerRef.current = L.circleMarker(e.latlng, {
        radius: 6, color: '#ffd34d', weight: 2, fillColor: '#ffd34d', fillOpacity: 0.4,
      }).addTo(map);

      const hits = [];
      const currentManifest = defManifestRef.current;
      if (currentManifest) {
        for (const layer of currentManifest.layers) {
          if (!defVisibleRef.current.has(layer.id)) continue;
          const v = await queryDefLayer(layer, lat, lng);
          if (v !== null) hits.push({ id: layer.id, name: layer.name, value: v });
        }
      }

      setDefQuery({ lat, lng, hits });
      
      const rows = hits.length
        ? hits.map((h) =>
            `<div class="pop-row"><span>${h.name}</span><b class="${h.value < 0 ? 'neg' : 'pos'}">${h.value.toFixed(2)} mm/yr</b></div>`
          ).join('')
        : '<div class="pop-none">No data at this point</div>';
      
      const popup = L.popup({ maxWidth: 290, className: 'vel-popup' })
        .setLatLng(e.latlng)
        .setContent(
          `<div class="pop-coord">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</div>${rows}`
        )
        .openOn(map);
      defPopupRef.current = popup;
    };

    map.on('click', onMapClick);

    return () => {
      map.off('click', onMapClick);
      if (defClickMarkerRef.current) { map.removeLayer(defClickMarkerRef.current); defClickMarkerRef.current = null; }
      if (defBoundariesLayerRef.current) { map.removeLayer(defBoundariesLayerRef.current); defBoundariesLayerRef.current = null; }
      if (defPopupRef.current) { map.closePopup(defPopupRef.current); defPopupRef.current = null; }
    };
  }, [analysisMode, defManifest, defIndiaGeoJson]);

  // Sync overlay layers based on visibility and opacity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "deformation" || !defManifest) return;

    for (const layer of defManifest.layers) {
      let ov = defOverlaysRef.current.get(layer.id);
      if (defVisibleLayers.has(layer.id)) {
        const imageUrl = `${import.meta.env.BASE_URL}velocity_data/${layer.png}`;
        if (!ov) {
          ov = L.imageOverlay(imageUrl, layer.bounds, {
            opacity: defOpacity,
            interactive: false,
          }).addTo(map);
          defOverlaysRef.current.set(layer.id, ov);
        } else {
          ov.setOpacity(defOpacity);
        }
      } else {
        if (ov) {
          map.removeLayer(ov);
          defOverlaysRef.current.delete(layer.id);
        }
      }
    }

    return () => {
      if (analysisMode !== "deformation") {
        for (const [id, ov] of defOverlaysRef.current.entries()) {
          if (mapRef.current) mapRef.current.removeLayer(ov);
        }
        defOverlaysRef.current.clear();
      }
    };
  }, [analysisMode, defManifest, defVisibleLayers, defOpacity]);

  // State selection and highlight zoom handling for Deformation mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "deformation") return;

    if (defStateHighlightRef.current) {
      map.removeLayer(defStateHighlightRef.current);
      defStateHighlightRef.current = null;
    }

    if (!defSelectedState || !defIndiaGeoJson) return;

    const feature = defIndiaGeoJson.features.find(
      (f) => (f.properties.STNAME_SH || f.properties.STNAME) === defSelectedState
    );
    if (!feature) return;

    const hl = L.geoJSON(feature, {
      style: {
        color: '#0BAFAF',
        weight: 3,
        fillColor: '#0BAFAF',
        fillOpacity: 0.08,
        opacity: 0.85,
      },
      interactive: false,
    }).addTo(map);
    defStateHighlightRef.current = hl;

    const bounds = hl.getBounds();
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { duration: 1.5, padding: [40, 40] });
    }

    return () => {
      if (defStateHighlightRef.current && mapRef.current) {
        mapRef.current.removeLayer(defStateHighlightRef.current);
        defStateHighlightRef.current = null;
      }
    };
  }, [analysisMode, defSelectedState, defIndiaGeoJson]);

  // ===========================================================
  // Climate Anomaly Atlas — derived data, selection & map effects
  // ===========================================================

  const climateFamilyOf = (varId) => (varId === "rainfall" ? "rainfall" : "temperature");
  const climateManifest = climateSources[climateFamilyOf(climateVar)]?.manifest || null;

  const climateAvailableYears = useMemo(() => {
    if (!climateManifest) return [];
    return [...new Set(climateManifest.weeks.map(w => w.year))].sort((a, b) => a - b);
  }, [climateManifest]);

  const climateAvailableMonths = useMemo(() => {
    if (!climateManifest || climateYear == null) return [];
    return [...new Set(climateManifest.weeks.filter(w => w.year === climateYear).map(w => w.month))].sort((a, b) => a - b);
  }, [climateManifest, climateYear]);

  const climateAvailableWeeks = useMemo(() => {
    if (!climateManifest || climateYear == null || climateMonth == null) return [];
    return climateManifest.weeks.filter(w => w.year === climateYear && w.month === climateMonth).map(w => w.week).sort((a, b) => a - b);
  }, [climateManifest, climateYear, climateMonth]);

  const climateDistrictIndex = useMemo(() => {
    const districtStates = new Map();
    const stateToDistricts = {};
    const allDistricts = [];
    if (climateDistrictsGeoJson) {
      climateDistrictsGeoJson.features.forEach(f => {
        const dt = f.properties[CLIMATE_DISTRICT_KEY];
        const st = f.properties[CLIMATE_STATE_KEY] || "—";
        if (!districtStates.has(dt)) districtStates.set(dt, []);
        if (!districtStates.get(dt).includes(st)) districtStates.get(dt).push(st);
        (stateToDistricts[st] ||= []).push(dt);
        allDistricts.push({ name: dt, state: st });
      });
      Object.keys(stateToDistricts).forEach(st => stateToDistricts[st].sort((a, b) => a.localeCompare(b)));
      allDistricts.sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state));
    }
    return { districtStates, stateToDistricts, allDistricts };
  }, [climateDistrictsGeoJson]);

  const climateStatesList = useMemo(
    () => Object.keys(climateDistrictIndex.stateToDistricts).sort((a, b) => a.localeCompare(b)),
    [climateDistrictIndex]
  );

  const climateDistrictOptions = useMemo(() => {
    if (climateStateFilter && climateDistrictIndex.stateToDistricts[climateStateFilter]) {
      return climateDistrictIndex.stateToDistricts[climateStateFilter].map(name => ({ name, state: climateStateFilter }));
    }
    return climateDistrictIndex.allDistricts;
  }, [climateDistrictIndex, climateStateFilter]);

  const climateHeroStats = useMemo(() => {
    const V = CLIMATE_VARIABLES[climateVar];
    const districts = climateWeekData?.districts || {};
    let surplus = 0, deficit = 0, total = 0;
    Object.values(districts).forEach(d => {
      total++;
      const c = d?.[V.fields.category];
      if (V.surplusKeys.has(c)) surplus++;
      else if (V.deficitKeys.has(c)) deficit++;
    });
    return { surplus, deficit, total };
  }, [climateWeekData, climateVar]);

  const climateDistribution = useMemo(() => {
    const V = CLIMATE_VARIABLES[climateVar];
    const districts = climateWeekData?.districts || {};
    const visibleCats = V.categories.filter(c => c.key !== "No Data");
    const counts = Object.fromEntries(visibleCats.map(c => [c.key, 0]));
    let withData = 0, total = 0;
    Object.values(districts).forEach(d => {
      total++;
      const c = d?.[V.fields.category];
      if (!c || c === "No Data") return;
      if (counts[c] !== undefined) counts[c]++;
      withData++;
    });
    const segments = visibleCats.filter(c => counts[c.key] > 0).map(c => ({ key: c.key, color: c.color, count: counts[c.key] }));
    return { segments, withData, total };
  }, [climateWeekData, climateVar]);

  const climateTrendSeries = useMemo(() => {
    if (!climateSelectedDistrict) return [];
    const family = climateFamilyOf(climateVar);
    const ts = climateTimeseriesCache[family];
    if (!ts) return [];
    const V = CLIMATE_VARIABLES[climateVar];
    const full = ts[climateSelectedDistrict] || [];
    return full
      .filter(r => r && typeof r.key === "string" && r.key.startsWith(`${climateYear}-`))
      .map(r => {
        const m = r.key.match(/^(\d{4})-(\d{2})-W(\d)$/);
        return {
          key: r.key,
          label: m ? `${CLIMATE_MONTH_NAMES[Number(m[2]) - 1].slice(0, 3)} W${m[3]}` : r.key,
          actualValue: r[V.fields.actual],
          normalValue: r[V.fields.normal],
          measureValue: r[V.fields.measure],
        };
      });
  }, [climateTimeseriesCache, climateSelectedDistrict, climateVar, climateYear]);

  // Kept fresh every render so the once-built GeoJSON layer's event handlers
  // (bound only when the geojson itself changes) never read stale week/var data.
  const climateLiveRef = useRef({});
  useEffect(() => {
    climateLiveRef.current = { weekData: climateWeekData, varId: climateVar, stateFilter: climateStateFilter };
  });

  const selectClimateDistrict = (name, stName, { fromMap = false } = {}) => {
    const states = climateDistrictIndex.districtStates.get(name) || [];
    if (!stName) {
      const filter = climateLiveRef.current.stateFilter;
      stName = states.length === 1 ? states[0] : (states.includes(filter) ? filter : states[0]);
    }
    setClimateSelectedDistrict(name);
    setClimateSelectedState(stName);

    if (climateHoveredLayerRef.current) {
      climateHoveredLayerRef.current.closeTooltip();
      climateHoveredLayerRef.current = null;
    }
    if (climateSelectedLayerRef.current) {
      climateSelectedLayerRef.current.setStyle({ weight: 0.3, color: "rgba(33,43,54,0.25)" });
      climateSelectedLayerRef.current.closeTooltip();
    }
    const layer = climateDistrictLayerMapRef.current.get(climateLK(name, stName))
      || (climateLayersByNameRef.current.get(name) || [])[0]?.layer;
    if (layer && mapRef.current) {
      climateSelectedLayerRef.current = layer;
      layer.setStyle({ weight: 2.4, color: "#0BAFAF" });
      layer.bringToFront();
      if (climateSelectedLabelRef.current) mapRef.current.removeLayer(climateSelectedLabelRef.current);
      climateSelectedLabelRef.current = L.marker(layer.getBounds().getCenter(), {
        icon: L.divIcon({ className: "district-label is-selected-label", html: name, iconSize: [180, 16], iconAnchor: [90, 8] }),
        interactive: false, pane: "climateLabels", keyboard: false,
      }).addTo(mapRef.current);
      if (!fromMap) mapRef.current.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 8 });
    }
    if (stName) setClimateStateFilter(stName);

    const family = climateFamilyOf(climateLiveRef.current.varId);
    if (!climateTimeseriesCache[family]) {
      fetch(`${CLIMATE_VARIABLES[climateLiveRef.current.varId].dataBase}/timeseries.json`)
        .then(r => { if (!r.ok) throw new Error(`timeseries: HTTP ${r.status}`); return r.json(); })
        .then(data => setClimateTimeseriesCache(prev => ({ ...prev, [family]: data })))
        .catch(err => setClimateLoadError(err.message || "Failed to load trend data."));
    }
  };
  const climateSelectDistrictRef = useRef(() => {});
  useEffect(() => { climateSelectDistrictRef.current = selectClimateDistrict; });

  // 1. Lazy-fetch: districts.geojson + rainfall manifest, only on first visit to the tab.
  useEffect(() => {
    if (analysisMode !== "climate" || climateDistrictsGeoJson) return;
    let cancelled = false;
    (async () => {
      try {
        setClimateLoadError("");
        const [districts, manifest] = await Promise.all([
          fetch(`${import.meta.env.BASE_URL}climate/districts.geojson`).then(r => { if (!r.ok) throw new Error(`districts.geojson: HTTP ${r.status}`); return r.json(); }),
          fetch(`${CLIMATE_VARIABLES.rainfall.dataBase}/manifest.json`).then(r => { if (!r.ok) throw new Error(`rainfall manifest: HTTP ${r.status}`); return r.json(); }),
        ]);
        if (cancelled) return;
        setClimateDistrictsGeoJson(districts);
        const weeksByKey = new Map(manifest.weeks.map(w => [w.key, w]));
        setClimateSources(prev => ({ ...prev, rainfall: { manifest, weeksByKey, weekCache: new Map() } }));
        const latest = manifest.weeks[manifest.weeks.length - 1];
        setClimateYear(latest.year);
        setClimateMonth(latest.month);
        setClimateWeek(latest.week);
      } catch (err) {
        if (!cancelled) setClimateLoadError(err.message || "Failed to load Climate Anomaly Atlas data.");
      }
    })();
    return () => { cancelled = true; };
  }, [analysisMode, climateDistrictsGeoJson]);

  // 2. Lazy-fetch the temperature manifest the first time tmax/tmin is selected.
  useEffect(() => {
    if (analysisMode !== "climate") return;
    const family = climateFamilyOf(climateVar);
    if (climateSources[family]) return;
    let cancelled = false;
    (async () => {
      try {
        const manifest = await fetch(`${CLIMATE_VARIABLES[climateVar].dataBase}/manifest.json`).then(r => { if (!r.ok) throw new Error(`${family} manifest: HTTP ${r.status}`); return r.json(); });
        if (cancelled) return;
        const weeksByKey = new Map(manifest.weeks.map(w => [w.key, w]));
        setClimateSources(prev => ({ ...prev, [family]: { manifest, weeksByKey, weekCache: new Map() } }));
        const currentKey = `${climateYear}-${String(climateMonth).padStart(2, '0')}-W${climateWeek}`;
        const target = weeksByKey.get(currentKey)
          || manifest.weeks.find(w => w.year === climateYear && w.month === climateMonth)
          || manifest.weeks.find(w => w.year === climateYear)
          || manifest.weeks[manifest.weeks.length - 1];
        setClimateYear(target.year);
        setClimateMonth(target.month);
        setClimateWeek(target.week);
      } catch (err) {
        if (!cancelled) setClimateLoadError(err.message || `Failed to load ${family} data.`);
      }
    })();
    return () => { cancelled = true; };
  }, [analysisMode, climateVar, climateSources, climateYear, climateMonth, climateWeek]);

  // 3. Fetch (and cache) the currently-selected week's district data.
  useEffect(() => {
    if (analysisMode !== "climate" || climateYear == null || climateMonth == null || climateWeek == null) return;
    const family = climateFamilyOf(climateVar);
    const src = climateSources[family];
    if (!src) return;
    const key = `${String(climateYear).padStart(4, '0')}-${String(climateMonth).padStart(2, '0')}-W${climateWeek}`;
    if (src.weekCache.has(key)) {
      setClimateWeekData(src.weekCache.get(key));
      return;
    }
    let cancelled = false;
    fetch(`${CLIMATE_VARIABLES[climateVar].dataBase}/weeks/${key}.json`)
      .then(r => { if (!r.ok) throw new Error(`week ${key}: HTTP ${r.status}`); return r.json(); })
      .then(data => {
        if (cancelled) return;
        src.weekCache.set(key, data);
        setClimateWeekData(data);
      })
      .catch(err => { if (!cancelled) setClimateLoadError(err.message || "Failed to load week data."); });
    return () => { cancelled = true; };
  }, [analysisMode, climateVar, climateYear, climateMonth, climateWeek, climateSources]);

  // 4. Build the district GeoJSON layer once (rebuilt only if the geojson itself changes).
  useEffect(() => {
    if (!climateDistrictsGeoJson) return;
    climateDistrictLayerMapRef.current = new Map();
    climateLayersByNameRef.current = new Map();
    climateLabelsRef.current = new Map();

    const layer = L.geoJSON(climateDistrictsGeoJson, {
      style: () => ({ color: "rgba(33,43,54,0.25)", weight: 0.3, fillColor: climateCatColor(climateVar, "No Data"), fillOpacity: 0.82 }),
      onEachFeature: (feature, lyr) => {
        const name = feature.properties[CLIMATE_DISTRICT_KEY];
        const st = feature.properties[CLIMATE_STATE_KEY] || "—";
        climateDistrictLayerMapRef.current.set(climateLK(name, st), lyr);
        if (!climateLayersByNameRef.current.has(name)) climateLayersByNameRef.current.set(name, []);
        climateLayersByNameRef.current.get(name).push({ state: st, layer: lyr });

        const bounds = lyr.getBounds();
        climateLabelsRef.current.set(climateLK(name, st), {
          name, latlng: bounds.getCenter(),
          isImportant: CLIMATE_IMPORTANT_DISTRICTS_LC.has(String(name).toLowerCase().trim()),
          marker: null,
        });

        lyr.on({
          mouseover: () => {
            if (lyr === climateSelectedLayerRef.current) return;
            // Explicitly close/reset whatever was previously hovered — on a dense
            // cluster of small polygons, a fast mouse crossing several districts
            // can skip a layer's own mouseout event, leaving its tooltip stuck open.
            const prev = climateHoveredLayerRef.current;
            if (prev && prev !== lyr) {
              prev.closeTooltip();
              if (prev !== climateSelectedLayerRef.current) {
                prev.setStyle({ weight: 0.3, color: "rgba(33,43,54,0.25)" });
              }
            }
            climateHoveredLayerRef.current = lyr;
            lyr.setStyle({ weight: 1.4, color: "#0BAFAF" });
            lyr.bringToFront();
            const { weekData, varId } = climateLiveRef.current;
            const V = CLIMATE_VARIABLES[varId];
            const rec = weekData?.districts?.[name];
            const cat = (rec ? rec[V.fields.category] : "No Data") || "No Data";
            const col = climateCatColor(varId, cat);
            const html = `
              <div class="tip-title-row">
                <span class="tip-marker" style="background:${col}"></span>
                <span class="tip-title">${name}</span>
              </div>
              <div class="tip-state">${climateTitleCase(st)}</div>
              <div class="tip-row"><span>Actual</span><span>${V.formatActual(rec?.[V.fields.actual])}</span></div>
              <div class="tip-row"><span>Normal</span><span>${V.formatNormal(rec?.[V.fields.normal])}</span></div>
              <div class="tip-row"><span>${V.measureLabel}</span><span>${V.formatMeasure(rec?.[V.fields.measure])}</span></div>
              <span class="tip-cat" style="background:${col};color:${climateContrastText(col)}">${cat}</span>
            `;
            lyr.bindTooltip(html, { sticky: true, direction: "top", className: "district-tip", offset: [0, -6] }).openTooltip();
          },
          mouseout: () => {
            if (climateHoveredLayerRef.current === lyr) climateHoveredLayerRef.current = null;
            if (lyr === climateSelectedLayerRef.current) return;
            lyr.setStyle({ weight: 0.3, color: "rgba(33,43,54,0.25)" });
            lyr.closeTooltip();
          },
          click: () => climateSelectDistrictRef.current(name, st, { fromMap: true }),
        });
      },
    });
    climateGeoLayerRef.current = layer;
  }, [climateDistrictsGeoJson]);

  // 5. Mount/unmount the layer + label pane as the user enters/leaves Climate mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "climate" || !climateGeoLayerRef.current) return;

    if (!map.getPane('climateLabels')) {
      map.createPane('climateLabels');
      map.getPane('climateLabels').style.zIndex = 450;
      map.getPane('climateLabels').style.pointerEvents = 'none';
    }
    if (!map.hasLayer(climateGeoLayerRef.current)) {
      climateGeoLayerRef.current.addTo(map);
      map.fitBounds(climateGeoLayerRef.current.getBounds(), { padding: [10, 10] });
    }

    const refreshLabels = () => {
      const zoom = map.getZoom();
      const bounds = map.getBounds();
      climateLabelsRef.current.forEach(info => {
        let shouldShow = false;
        if (zoom >= 9) shouldShow = bounds.contains(info.latlng);
        else if (zoom >= 7) shouldShow = info.isImportant && bounds.contains(info.latlng);
        if (shouldShow) {
          if (!info.marker) {
            info.marker = L.marker(info.latlng, {
              icon: L.divIcon({
                className: "district-label" + (info.isImportant ? " is-important-label" : ""),
                html: info.name, iconSize: [150, 14], iconAnchor: [75, 7],
              }),
              interactive: false, pane: "climateLabels", keyboard: false,
            });
          }
          if (!info.marker._map) info.marker.addTo(map);
        } else if (info.marker?._map) {
          map.removeLayer(info.marker);
        }
      });
    };
    const scheduleRefresh = () => {
      if (climateLabelFrameRef.current) cancelAnimationFrame(climateLabelFrameRef.current);
      climateLabelFrameRef.current = requestAnimationFrame(refreshLabels);
    };
    map.on('zoomend moveend', scheduleRefresh);
    scheduleRefresh();

    return () => {
      map.off('zoomend moveend', scheduleRefresh);
      if (climateLabelFrameRef.current) cancelAnimationFrame(climateLabelFrameRef.current);
      if (climateGeoLayerRef.current && map.hasLayer(climateGeoLayerRef.current)) {
        map.removeLayer(climateGeoLayerRef.current);
      }
      climateLabelsRef.current.forEach(info => {
        if (info.marker?._map) map.removeLayer(info.marker);
      });
      if (climateSelectedLabelRef.current && map.hasLayer(climateSelectedLabelRef.current)) {
        map.removeLayer(climateSelectedLabelRef.current);
      }
    };
  }, [analysisMode, climateDistrictsGeoJson]);

  // 6. Restyle every district's fill color whenever the active week or variable changes.
  useEffect(() => {
    if (!climateGeoLayerRef.current || !climateWeekData) return;
    const V = CLIMATE_VARIABLES[climateVar];
    const catField = V.fields.category;
    const districts = climateWeekData.districts;
    climateGeoLayerRef.current.eachLayer(lyr => {
      const name = lyr.feature.properties[CLIMATE_DISTRICT_KEY];
      const rec = districts[name];
      const cat = rec ? rec[catField] : "No Data";
      lyr.setStyle({ fillColor: climateCatColor(climateVar, cat || "No Data") });
    });
  }, [climateWeekData, climateVar]);

  // ===========================================================
  // AWD & Flooding Plots — derived data, selection & map effects
  // ===========================================================

  const awdFidList = useMemo(() => {
    if (!awdData) return [];
    return [...new Set(awdData.geojson.features.map(f => f.properties.FID))].sort((a, b) => Number(a) - Number(b));
  }, [awdData]);

  const awdSelectedProps = useMemo(() => {
    if (!awdData || awdSelectedFid == null) return null;
    const f = awdData.geojson.features.find(f => String(f.properties.FID) === String(awdSelectedFid));
    return f ? f.properties : null;
  }, [awdData, awdSelectedFid]);

  const awdSelectedDepthCm = useMemo(() => {
    if (!awdData || awdSelectedFid == null) return [];
    const series = awdData.depth[String(awdSelectedFid)] || [];
    return series.map(v => (v == null ? null : v * awdData.rwdiToCm));
  }, [awdData, awdSelectedFid]);

  const awdPlotInsights = useMemo(() => {
    if (!awdData) return null;
    const feats = awdData.geojson.features;
    const areas = feats.map(f => f.properties.parea).filter(v => v != null);
    const totalArea = areas.reduce((s, v) => s + v, 0);
    const avgArea = areas.length ? totalArea / areas.length : 0;
    const methodCounts = {};
    feats.forEach(f => { const m = f.properties.method; if (m) methodCounts[m] = (methodCounts[m] || 0) + 1; });
    const primaryMethod = Object.entries(methodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
    return { totalArea, avgArea, primaryMethod, plotCount: feats.length };
  }, [awdData]);

  const awdLiveColorByRef = useRef("total");
  useEffect(() => { awdLiveColorByRef.current = awdColorByKey; });

  const selectAwdPlot = (fid) => {
    const layer = awdFidLayerRef.current[fid];
    if (awdSelectedLayerRef.current) {
      awdSelectedLayerRef.current.setStyle({ weight: 0.4, color: '#11161d' });
    }
    if (layer) {
      awdSelectedLayerRef.current = layer;
      layer.setStyle({ weight: 2.0, color: '#0BAFAF' });
      layer.bringToFront();
      if (mapRef.current) mapRef.current.fitBounds(layer.getBounds(), { maxZoom: 18, padding: [60, 60] });
    }
    setAwdSelectedFid(fid);
  };

  const handleAwdSearch = () => {
    const raw = awdSearchText.trim();
    if (raw === "") { setAwdSearchMsg(null); return; }
    const layer = awdFidLayerRef.current[raw];
    if (!layer) { setAwdSearchMsg({ text: `No plot with ID ${raw}`, isError: true }); return; }
    setAwdSearchMsg({ text: `Showing plot #${raw}`, isError: false });
    selectAwdPlot(raw);

    if (awdFlashTimerRef.current) clearTimeout(awdFlashTimerRef.current);
    layer.setStyle({ weight: 3.0, color: '#ffd000' });
    layer.bringToFront();
    awdFlashTimerRef.current = setTimeout(() => {
      layer.setStyle(awdSelectedLayerRef.current === layer ? { weight: 2.0, color: '#0BAFAF' } : { weight: 0.4, color: '#11161d' });
    }, 2200);
  };

  // 1. Lazy-fetch + client-side quantile/color precompute, only on first visit to the tab.
  useEffect(() => {
    if (analysisMode !== "awd" || awdData) return;
    let cancelled = false;
    (async () => {
      try {
        setAwdLoadError("");
        const raw = await fetch(`${import.meta.env.BASE_URL}awd/awd_data.json`).then(r => { if (!r.ok) throw new Error(`awd_data.json: HTTP ${r.status}`); return r.json(); });
        if (cancelled) return;
        const varByKey = Object.fromEntries(raw.varDefs.map(v => [v.key, v]));
        for (const vd of raw.varDefs) {
          if (vd.type === 'num') {
            const vals = raw.geojson.features.map(f => f.properties[vd.key]);
            vd.breaks = awdQuantiles(vals, 6);
            vd.colors = AWD_RAMPS[vd.ramp];
            const finite = vals.filter(x => x != null);
            vd.min = finite.length ? Math.min(...finite) : null;
            vd.max = finite.length ? Math.max(...finite) : null;
          }
        }
        raw.varByKey = varByKey;
        setAwdData(raw);
      } catch (err) {
        if (!cancelled) setAwdLoadError(err.message || "Failed to load AWD plot data.");
      }
    })();
    return () => { cancelled = true; };
  }, [analysisMode, awdData]);

  // 2. Build the plot GeoJSON layer once (canvas-rendered — ~5,000 small polygons).
  useEffect(() => {
    if (!awdData) return;
    awdFidLayerRef.current = {};
    const layer = L.geoJSON(awdData.geojson, {
      renderer: L.canvas(),
      style: f => ({
        fillColor: awdColorFor(awdData.varByKey[awdLiveColorByRef.current], f.properties[awdLiveColorByRef.current]),
        fillOpacity: 0.72, color: '#11161d', weight: 0.4,
      }),
      onEachFeature: (f, lyr) => {
        awdFidLayerRef.current[f.properties.FID] = lyr;
        lyr.on('click', () => selectAwdPlot(f.properties.FID));
        lyr.on('mouseover', () => lyr.setStyle({ weight: 1.6, color: '#ffffff' }));
        lyr.on('mouseout', () => {
          lyr.setStyle(awdSelectedLayerRef.current === lyr ? { weight: 2.0, color: '#0BAFAF' } : { weight: 0.4, color: '#11161d' });
        });
      },
    });
    awdGeoLayerRef.current = layer;
  }, [awdData]);

  // 3. Mount/unmount the plot layer as the user enters/leaves AWD mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || analysisMode !== "awd" || !awdGeoLayerRef.current) return;
    if (!map.hasLayer(awdGeoLayerRef.current)) {
      awdGeoLayerRef.current.addTo(map);
      map.fitBounds(awdGeoLayerRef.current.getBounds(), { padding: [20, 20] });
    }
    return () => {
      if (awdGeoLayerRef.current && map.hasLayer(awdGeoLayerRef.current)) {
        map.removeLayer(awdGeoLayerRef.current);
      }
    };
  }, [analysisMode, awdData]);

  // 4. Restyle every plot's fill color whenever the color-by variable changes.
  useEffect(() => {
    if (!awdGeoLayerRef.current || !awdData) return;
    const varDef = awdData.varByKey[awdColorByKey];
    awdGeoLayerRef.current.setStyle(f => ({
      fillColor: awdColorFor(varDef, f.properties[awdColorByKey]),
      fillOpacity: 0.72, color: '#11161d', weight: 0.4,
    }));
  }, [awdColorByKey, awdData]);

  const handleLsmSubmitFocus = () => {
    if (!lsmTempDistrict) return;
    const dist = lsmDistrictsInState.find(d => d.district === lsmTempDistrict);
    if (!dist) return;

    setLsmSelectedDistrict(dist);

    // Fetch district boundary GeoJSON
    const filename = `${sanitizeLsmFilename(dist.state)}_${sanitizeLsmFilename(dist.district)}.json`;
    fetch(`${import.meta.env.BASE_URL}districts_geo/${filename}`)
      .then(res => res.json())
      .then(data => setLsmDistrictGeoJson(data))
      .catch(err => console.error("Error loading district geometry:", err));

    // Look up precomputed stats
    const key = `${dist.state}_${dist.district}`;
    const statsData = lsmPrecomputedStats[key];
    if (statsData) {
      setLsmDistrictStats(statsData.stats);
      setLsmAnalyzedPercent(statsData.analyzed_percentage);
      setLsmProbabilityStats(statsData.probability);
    } else {
      // Trigger dynamic backend stats query as fallback
      fetch(`${API_BASE}/api/district-stats?state=${dist.state}&district=${dist.district}`)
        .then(res => res.json())
        .then(data => {
          if (data.stats) {
            setLsmDistrictStats(data.stats);
            setLsmAnalyzedPercent(data.analyzed_percentage);
            setLsmProbabilityStats(null);
          } else {
            setLsmDistrictStats({ '1': 0.0, '2': 0.0, '3': 0.0, '4': 0.0, '5': 0.0 });
            setLsmAnalyzedPercent(0.0);
            setLsmProbabilityStats(null);
          }
        })
        .catch(err => {
          setLsmDistrictStats({ '1': 0.0, '2': 0.0, '3': 0.0, '4': 0.0, '5': 0.0 });
          setLsmAnalyzedPercent(0.0);
          setLsmProbabilityStats(null);
        });
    }
  };

  const handleLsmClearSelection = () => {
    setLsmSelectedState('');
    setLsmTempDistrict('');
    setLsmSelectedDistrict(null);
    setLsmDistrictGeoJson(null);
    setLsmDistrictStats({
      '1': 12.9,
      '2': 24.2,
      '3': 27.0,
      '4': 35.9,
      '5': 0.0
    });
    setLsmAnalyzedPercent(70);
    setLsmProbabilityStats(null);

    // Zoom back to India
    if (mapRef.current) {
      mapRef.current.fitBounds([
        [7.874581612284692, 68.6315],
        [37.0005, 97.2604328483906]
      ]);
    }
  };

  // Toast notification alert helper
  const showToast = (message, isError = false) => {
    setToast({ message, isError });
    setTimeout(() => setToast(null), 4000);
  };

  // Live highway analysis via backend (fallback when precomputed files are absent)
  const fetchLiveHighwayStats = (name, bufferM) => {
    return fetch(`${API_BASE}/api/highway-stats?name=${encodeURIComponent(name)}&buffer=${bufferM}`)
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Highway analysis failed");
        return data;
      })
      .then(data => {
        const { segments, buffer_polygons, ...stats } = data;
        setLsmSelectedHighway(prev =>
          prev && prev.name === stats.name
            ? { ...prev, ...stats, corridor: { ...prev.corridor, ...stats.corridor }, probability: { ...prev.probability, ...stats.probability } }
            : stats
        );
        setLsmHighwaySegments({ segments, buffer_polygons, step_m: data.step_m });
      });
  };

  const handleLsmHighwaySubmit = () => {
    if (!lsmTempHighway) return;
    const entry = (lsmHighwayStatsData || []).find(h => h.name === lsmTempHighway);
    setLsmHighwayLoading(true);
    setLsmHighwaySegments(null); // drop the previous highway's geometry while the new one loads
    const done = () => setLsmHighwayLoading(false);

    if (entry) {
      setLsmSelectedHighway(entry);
      // Precomputed map geometry (segments + buffer polygons), mirrors districts_geo/.
      // The filename comes from the stats entry — names like "NH 752I" vs
      // "NH 752i" collide case-insensitively, so it can't be derived here.
      const segFile = entry.seg || `${sanitizeLsmFilename(lsmTempHighway)}.json`;
      fetch(`${import.meta.env.BASE_URL}highway_segments/${segFile}`)
        .then(res => { if (!res.ok) throw new Error("segments missing"); return res.json(); })
        .then(data => setLsmHighwaySegments(data))
        .catch(() =>
          fetchLiveHighwayStats(lsmTempHighway, lsmBufferM).catch(() => {
            setLsmHighwaySegments(null);
            showToast("Highway map layers unavailable — showing statistics only", true);
          })
        )
        .finally(done);
    } else {
      fetchLiveHighwayStats(lsmTempHighway, lsmBufferM)
        .catch(err => showToast(err.message || "Highway analysis unavailable (backend offline)", true))
        .finally(done);
    }
  };

  const handleLsmHighwayClear = () => {
    setLsmTempHighway('');
    setLsmHighwayFilter('');
    setLsmSelectedHighway(null);
    setLsmHighwaySegments(null);
    lsmHighwayFlownRef.current = null;

    // Zoom back to India
    if (mapRef.current) {
      mapRef.current.fitBounds([
        [7.874581612284692, 68.6315],
        [37.0005, 97.2604328483906]
      ]);
    }
  };

  const handleLsmFocusTypeSwitch = (type) => {
    if (type === lsmFocusType) return;
    setLsmFocusType(type);
    if (type === 'district' && lsmSelectedHighway) handleLsmHighwayClear();
    if (type === 'highway' && lsmSelectedDistrict) handleLsmClearSelection();
  };

  // A live-computed result only carries the buffer width it was requested with;
  // refetch when the user switches to a width it doesn't have yet.
  useEffect(() => {
    if (!lsmSelectedHighway) return;
    if (lsmSelectedHighway.corridor && lsmSelectedHighway.corridor[String(lsmBufferM)]) return;
    fetchLiveHighwayStats(lsmSelectedHighway.name, lsmBufferM)
      .catch(() => showToast("Backend offline — no stats for this buffer width", true));
  }, [lsmBufferM]);

  const updateDrawingLayer = (vertices, isPreview = false) => {
    const map = mapRef.current;
    if (!map) return;

    if (drawLineRef.current) {
      map.removeLayer(drawLineRef.current);
      drawLineRef.current = null;
    }

    const drawColor = drawingTarget === "query" ? '#f59e0b' : '#dc2626';
    const drawFill = drawingTarget === "query" ? 'rgba(245,158,11,0.1)' : 'rgba(220,38,38,0.1)';

    if (vertices.length > 0) {
      if (vertices.length >= 3 && !isPreview) {
        drawLineRef.current = L.polygon(vertices, {
          color: drawColor,
          weight: 2.5,
          fillColor: drawFill,
          dashArray: null
        }).addTo(map);
      } else {
        drawLineRef.current = L.polyline(vertices, {
          color: drawColor,
          weight: 2,
          dashArray: '5, 5'
        }).addTo(map);
      }
    }

    const actualVertices = isPreview ? vertices.slice(0, -1) : vertices;

    if (actualVertices.length >= 3) {
      if (!firstVertexMarkerRef.current) {
        firstVertexMarkerRef.current = L.circleMarker(actualVertices[0], {
          radius: 8,
          color: drawColor,
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 3,
          interactive: true
        })
        .addTo(map)
        .bindTooltip("Click to close shape", { permanent: false, direction: 'top' });

        firstVertexMarkerRef.current.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          finishDrawingPolygon();
        });
      } else {
        firstVertexMarkerRef.current.setLatLng(actualVertices[0]);
      }
    } else {
      if (firstVertexMarkerRef.current) {
        map.removeLayer(firstVertexMarkerRef.current);
        firstVertexMarkerRef.current = null;
      }
    }
  };

  const finishDrawingPolygon = () => {
    const vertices = drawVerticesRef.current;
    if (vertices.length < 3) {
      showToast("Please click at least 3 points to define a polygon.", true);
      return;
    }

    // Create closed coordinates loop: [lon, lat] for GeoJSON
    const coordinates = vertices.map(v => [v[1], v[0]]);
    coordinates.push(coordinates[0]); // close loop

    const geojson = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coordinates]
      },
      properties: {}
    };

    if (drawingTarget === "query") {
      let newGeojson;
      if (queryGeometry && queryGeometry.type === "FeatureCollection") {
        newGeojson = {
          ...queryGeometry,
          features: [...queryGeometry.features, geojson]
        };
      } else if (queryGeometry) {
        const existingFeature = queryGeometry.type === "Feature" ? queryGeometry : {
          type: "Feature",
          geometry: queryGeometry,
          properties: {}
        };
        newGeojson = {
          type: "FeatureCollection",
          features: [existingFeature, geojson]
        };
      } else {
        newGeojson = geojson;
      }
      setQueryGeometry(newGeojson);
      const count = newGeojson.type === "FeatureCollection" ? newGeojson.features.length : 1;
      setQueryFileName(`${count} Drawn Query Feature${count > 1 ? 's' : ''}`);
      stopDrawMode();
      showToast("Query feature drawn successfully");
      return;
    }

    // Compute bounding box
    const lons = vertices.map(v => v[1]);
    const lats = vertices.map(v => v[0]);
    const minL = Math.min(...lons);
    const maxL = Math.max(...lons);
    const minT = Math.min(...lats);
    const maxT = Math.max(...lats);

    setMinLon(parseFloat(minL.toFixed(6)));
    setMaxLon(parseFloat(maxL.toFixed(6)));
    setMinLat(parseFloat(minT.toFixed(6)));
    setMaxLat(parseFloat(maxT.toFixed(6)));

    setPointLat(parseFloat(((minT + maxT) / 2).toFixed(6)));
    setPointLon(parseFloat(((minL + maxL) / 2).toFixed(6)));

    setUploadedGeoJson(geojson);
    setUploadedFileName("Drawn Polygon ROI");
    setRoiMethod("file");

    stopDrawMode();
    showToast("Custom polygon drawn successfully");
  };

  // Enable/disable draw mode on the map
  const startDrawMode = (target = "roi") => {
    setIsDrawing(true);
    setDrawingTarget(target);
    if (target === "roi") {
      setRoiMethod("draw");
      setUploadedGeoJson(null);
      setUploadedFileName("");
    }
    setDrawVertices([]);
    if (mapRef.current) {
      mapRef.current.getContainer().style.cursor = 'crosshair';
      mapRef.current.doubleClickZoom.disable();
    }
    showToast(`Click on map to draw ${target === "roi" ? "ROI" : "Query Feature"} vertices. Click the first point to close.`);
  };

  const stopDrawMode = () => {
    setIsDrawing(false);
    setDrawVertices([]);
    if (mapRef.current) {
      mapRef.current.getContainer().style.cursor = '';
      mapRef.current.doubleClickZoom.enable();
    }
    if (drawLineRef.current && mapRef.current) {
      mapRef.current.removeLayer(drawLineRef.current);
      drawLineRef.current = null;
    }
    if (firstVertexMarkerRef.current && mapRef.current) {
      mapRef.current.removeLayer(firstVertexMarkerRef.current);
      firstVertexMarkerRef.current = null;
    }
  };

  // Map draw interaction handlers
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    const onClick = (e) => {
      if (!isDrawing) return;

      // Close polygon if clicking near first vertex
      if (drawVerticesRef.current.length >= 3) {
        const firstLatLng = L.latLng(drawVerticesRef.current[0]);
        const p1 = map.latLngToLayerPoint(firstLatLng);
        const p2 = map.latLngToLayerPoint(e.latlng);
        const pixelDistance = p1.distanceTo(p2);
        if (pixelDistance < 15) {
          finishDrawingPolygon();
          return;
        }
      }

      const newVertex = [e.latlng.lat, e.latlng.lng];
      const next = [...drawVerticesRef.current, newVertex];
      setDrawVertices(next);
      updateDrawingLayer(next);
    };

    const onMouseMove = (e) => {
      if (!isDrawing || drawVerticesRef.current.length === 0) return;
      const currentMousePos = [e.latlng.lat, e.latlng.lng];
      updateDrawingLayer([...drawVerticesRef.current, currentMousePos], true);
    };

    const onDblClick = (e) => {
      if (!isDrawing) return;
      e.originalEvent.stopPropagation();
      finishDrawingPolygon();
    };

    map.on('click', onClick);
    map.on('mousemove', onMouseMove);
    map.on('dblclick', onDblClick);

    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMouseMove);
      map.off('dblclick', onDblClick);
    };
  }, [isDrawing, drawingTarget]);

  // Leaflet Map Setup
  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      const map = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false
      }).setView([pointLat, pointLon], 11);
      
      mapRef.current = map;

      // Map Tile Layers
      const satelliteTiles = L.tileLayer(
        'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        { maxZoom: 20, attribution: 'Google' }
      );
      const streetTiles = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 19 }
      );
      const lightTiles = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19 }
      );

      baseTilesRef.current = { satellite: satelliteTiles, streets: streetTiles, light: lightTiles };
      climateLightTilesRef.current = lightTiles;
      satelliteTiles.addTo(map);

      // Track coordinates under mouse cursor
      map.on('mousemove', (e) => {
        setHoverCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
    }
  }, []);

  // Update base tiles — Climate Anomaly Atlas forces the light CARTO basemap
  // (needed for choropleth fill contrast) regardless of the global toggle,
  // and restores whichever of satellite/streets the toggle dictates on exit.
  useEffect(() => {
    if (mapRef.current && baseTilesRef.current) {
      const map = mapRef.current;
      const { satellite, streets, light } = baseTilesRef.current;

      if (analysisMode === "climate") {
        if (map.hasLayer(satellite)) map.removeLayer(satellite);
        if (map.hasLayer(streets)) map.removeLayer(streets);
        if (!map.hasLayer(light)) light.addTo(map);
        return;
      }
      if (map.hasLayer(light)) map.removeLayer(light);

      if (baseMap === "satellite") {
        map.removeLayer(streets);
        satellite.addTo(map);
      } else {
        map.removeLayer(satellite);
        streets.addTo(map);
      }
    }
  }, [baseMap, analysisMode]);

  // Sync ROI layer (rectangle or custom polygon) on change
  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current;

      // Remove existing layers
      if (roiLayerRef.current) {
        map.removeLayer(roiLayerRef.current);
        roiLayerRef.current = null;
      }
      if (geoJsonLayerRef.current) {
        map.removeLayer(geoJsonLayerRef.current);
        geoJsonLayerRef.current = null;
      }

      // Render new layer based on method
      if (roiMethod === "file" && uploadedGeoJson) {
        const layer = L.geoJSON(uploadedGeoJson, {
          style: {
            color: "#dc2626",
            weight: 2.5,
            fillColor: "rgba(220, 38, 38, 0.06)",
            dashArray: null
          }
        }).addTo(map);
        geoJsonLayerRef.current = layer;
        map.fitBounds(layer.getBounds(), { padding: [50, 50] });
      }
    }
  }, [minLon, minLat, maxLon, maxLat, roiMethod, uploadedGeoJson]);

  // Sync Query Geometry layer on change
  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current;
      if (queryLayerRef.current) {
        map.removeLayer(queryLayerRef.current);
        queryLayerRef.current = null;
      }
      if (queryGeometry) {
        const layer = L.geoJSON(queryGeometry, {
          style: {
            color: "#f59e0b", // Amber/Orange
            weight: 2.5,
            fillColor: "rgba(245, 158, 11, 0.15)",
            dashArray: null
          }
        }).addTo(map);
        queryLayerRef.current = layer;
      }
    }
  }, [queryGeometry]);

  // Sync raster overlay opacity when slider changes
  useEffect(() => {
    if (imageOverlayRef.current) {
      imageOverlayRef.current.setOpacity(overlayOpacity);
    }
  }, [overlayOpacity]);

  // Keep the swipe-x ref in sync for use inside map event handlers
  useEffect(() => { floodSwipeXRef.current = floodSwipeX; }, [floodSwipeX]);

  // Sync flood overlay opacities + swipe clip when slider/toggle/opacity change
  useEffect(() => {
    applyFloodOpacities();
    applySwipeClip();
  }, [floodSwipeX, floodShowMask, overlayOpacity]);

  // Re-clip the flood swipe whenever the map is panned, zoomed, or resized so the
  // divider stays glued to its screen position.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !(analysisMode === "flood" && floodResult)) return;
    const handler = () => applySwipeClip();
    map.on("move zoom zoomanim moveend zoomend resize", handler);
    window.addEventListener("resize", handler);
    return () => {
      map.off("move zoom zoomanim moveend zoomend resize", handler);
      window.removeEventListener("resize", handler);
    };
  }, [analysisMode, floodResult]);

  // Drag the vertical swipe divider on the map
  useEffect(() => {
    if (!floodSwipeDragging) return;
    const onMove = (e) => {
      const mapEl = mapContainerRef.current;
      if (!mapEl) return;
      const rect = mapEl.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setFloodSwipeX(frac);
    };
    const onUp = () => setFloodSwipeDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [floodSwipeDragging]);

  const handleLocateClient = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        if (mapRef.current) {
          mapRef.current.setView([latitude, longitude], 13);
          setPointLat(parseFloat(latitude.toFixed(6)));
          setPointLon(parseFloat(longitude.toFixed(6)));
          showToast("GPS position acquired and synced.");
        }
      }, (err) => {
        showToast("GPS location failed or permission denied.", true);
      });
    } else {
      showToast("Geolocation not supported by browser.", true);
    }
  };

  const toggleFullscreen = () => {
    const mapContainer = mapContainerRef.current?.parentElement;
    if (!mapContainer) return;
    if (!document.fullscreenElement) {
      mapContainer.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (!searchCoords) return;
    const parts = searchCoords.split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const [lat, lon] = parts;
      if (mapRef.current) {
        mapRef.current.setView([lat, lon], 12);
        showToast(`Centered map at Lat: ${lat}, Lon: ${lon}`);
      }
    } else {
      showToast("Format must be 'lat, lon'", true);
    }
  };

  // Center ROI on map center
  const setRoiToMapCenter = () => {
    if (mapRef.current) {
      const center = mapRef.current.getCenter();
      setPointLat(parseFloat(center.lat.toFixed(6)));
      setPointLon(parseFloat(center.lng.toFixed(6)));
      setRoiMethod("point");
      showToast("ROI locked to current viewport center");
    }
  };

  // KML/GeoJSON upload handler
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      let parseResult = null;

      if (file.name.endsWith(".kml")) {
        parseResult = parseKmlText(text);
      } else if (file.name.endsWith(".geojson") || file.name.endsWith(".json")) {
        parseResult = parseGeoJsonText(text);
      }

      if (parseResult && parseResult.bounds) {
        const { minLon, minLat, maxLon, maxLat } = parseResult.bounds;
        setMinLon(parseFloat(minLon.toFixed(6)));
        setMaxLon(parseFloat(maxLon.toFixed(6)));
        setMinLat(parseFloat(minLat.toFixed(6)));
        setMaxLat(parseFloat(maxLat.toFixed(6)));
        
        // Pointers representation
        setPointLat(parseFloat(((minLat + maxLat) / 2).toFixed(6)));
        setPointLon(parseFloat(((minLon + maxLon) / 2).toFixed(6)));
        
        setUploadedGeoJson(parseResult.geojson);
        showToast(`Boundary ROI loaded from ${file.name}`);
      } else {
        showToast("No valid polygon coordinate vectors found in file.", true);
      }
    };
    reader.readAsText(file);
  };

  // Query feature KML/GeoJSON upload handler (AI Similarity search).
  // Unlike the ROI upload this does NOT touch the bounding box — the query
  // feature is a small reference area that lives inside the Target ROI.
  const handleQueryFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      let parseResult = null;

      if (file.name.endsWith(".kml")) {
        parseResult = parseKmlText(text);
      } else if (file.name.endsWith(".geojson") || file.name.endsWith(".json")) {
        parseResult = parseGeoJsonText(text);
      }

      if (parseResult && parseResult.geojson) {
        setQueryGeometry(parseResult.geojson);
        setQueryFileName(file.name);
        showToast(`Query feature loaded from ${file.name}`);
      } else {
        showToast("No valid polygon coordinate vectors found in file.", true);
      }
    };
    reader.readAsText(file);
    // Reset so re-selecting the same file fires onChange again
    e.target.value = "";
  };

  // Sync selected scene metadata for footer HUD display
  useEffect(() => {
    if (selectedSceneId && scenes.length > 0) {
      const matched = scenes.find(s => s.id === selectedSceneId);
      if (matched) {
        let sensorName = "Sentinel-2 MSI";
        let res = "10 m";
        
        if (platform.includes("Landsat")) {
          sensorName = "Landsat C2 L2";
          res = "30 m";
        } else if (platform.includes("Sentinel-1")) {
          sensorName = "Sentinel-1 SAR";
          res = "10 m";
        }
        
        setSelectedSceneMeta({
          sensor: sensorName,
          resolution: res,
          date: matched.date,
          cloudCover: matched.cloud_cover !== null ? `${matched.cloud_cover.toFixed(1)}%` : "0%",
          sceneId: matched.id,
          orbit: matched.properties?.["sat:relative_orbit"] || matched.id.split("_")[4] || "N/A"
        });
      }
    } else {
      setSelectedSceneMeta(null);
    }
  }, [selectedSceneId, scenes, platform]);

  // 1. Search scenes in STAC catalog
  const triggerStacSearch = async () => {
    setSearchLoading(true);
    setScenes([]);
    setSelectedSceneId("");
    setSelectedSceneMeta(null);
    
    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          bbox: [minLon, minLat, maxLon, maxLat],
          start_date: startDate,
          end_date: endDate,
          cloud_cover: cloudCover,
          orbit
        })
      });
      
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Search query rejected");
      }
      
      const data = await res.json();
      setScenes(data.scenes);
      if (data.scenes.length > 0) {
        setSelectedSceneId(data.scenes[0].id);
        showToast(`Discovered ${data.scenes.length} available scenes`);
      } else {
        showToast("No telemetry scenes matched search windows.", true);
      }
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setSearchLoading(false);
    }
  };

  const clearMapOverlay = () => {
    const map = mapRef.current;
    if (imageOverlayRef.current && map) {
      map.removeLayer(imageOverlayRef.current);
      imageOverlayRef.current = null;
    }
    // Tear down the flood time-slider overlays (before / after / mask).
    for (const ref of [floodBeforeOverlayRef, floodAfterOverlayRef, floodMaskOverlayRef]) {
      if (ref.current && map) {
        map.removeLayer(ref.current);
        ref.current = null;
      }
    }
  };

  // Both flood scenes render at full opacity; the vertical swipe divider clips them
  // so left shows post-event and right shows pre-event. The red mask (flood extent)
  // sits on top of the post-event (left) side and can be toggled off.
  const applyFloodOpacities = () => {
    if (floodBeforeOverlayRef.current) floodBeforeOverlayRef.current.setOpacity(overlayOpacity);
    if (floodAfterOverlayRef.current) floodAfterOverlayRef.current.setOpacity(overlayOpacity);
    if (floodMaskOverlayRef.current) floodMaskOverlayRef.current.setOpacity(floodShowMask ? overlayOpacity : 0);
  };

  // Clip the flood overlays to the swipe divider (screen-space, so it stays aligned
  // while the map is panned/zoomed). divX is the divider's screen x in the map.
  const applySwipeClip = () => {
    const mapEl = mapContainerRef.current;
    if (!mapEl) return;
    const mapRect = mapEl.getBoundingClientRect();
    const divX = mapRect.left + floodSwipeXRef.current * mapRect.width;
    const clip = (ovRef, side) => {
      const ov = ovRef.current;
      const el = ov && ov.getElement ? ov.getElement() : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      if (side === "left") {
        const hideRight = Math.min(r.width, Math.max(0, r.right - divX));
        el.style.clipPath = `inset(0px ${hideRight}px 0px 0px)`;
      } else {
        const hideLeft = Math.min(r.width, Math.max(0, divX - r.left));
        el.style.clipPath = `inset(0px 0px 0px ${hideLeft}px)`;
      }
    };
    clip(floodAfterOverlayRef, "left");    // post-event scene, left of divider
    clip(floodMaskOverlayRef, "left");     // red flood extent over post side only
    clip(floodBeforeOverlayRef, "right");  // pre-event scene, right of divider
  };

  // Build the before/after/mask overlays for a flood result and fit the map to them.
  const setupFloodOverlays = (result) => {
    if (!mapRef.current) return;
    clearMapOverlay();
    const b = result.bbox;
    const bounds = [[b[1], b[0]], [b[3], b[2]]];
    const mk = (url, z) => {
      const ov = L.imageOverlay(`${API_BASE}${url}`, bounds, {
        opacity: 0, interactive: false, zIndex: z
      }).addTo(mapRef.current);
      const el = ov.getElement && ov.getElement();
      if (el) el.addEventListener("load", applySwipeClip);
      return ov;
    };
    floodBeforeOverlayRef.current = mk(result.before_url, 400);
    floodAfterOverlayRef.current = mk(result.after_url, 401);
    floodMaskOverlayRef.current = mk(result.image_url, 402);
    applyFloodOpacities();
    mapRef.current.fitBounds(bounds);
    // Re-clip after Leaflet positions the overlays for the new view.
    setTimeout(applySwipeClip, 0);
  };

  const handleClearAll = () => {
    clearMapOverlay();
    setSpectralResult(null);
    setTimeSeriesResult(null);
    setLulcResult(null);
    setAefResult(null);
    setSimilarityResult(null);
    setFloodResult(null);
    setEtSingleResult(null);
    setEtSeriesResult(null);
    setQueryGeometry(null);
    setQueryFileName("");
    setCustomClusterNames({});

    // Clear LSM map layers only when we are leaving LSM mode
    if (analysisMode !== "lsm") {
      const map = mapRef.current;
      if (map) {
        if (lsmOverlayLayerRef.current) { map.removeLayer(lsmOverlayLayerRef.current); lsmOverlayLayerRef.current = null; }
        if (lsmDistrictBoundaryLayerRef.current) { map.removeLayer(lsmDistrictBoundaryLayerRef.current); lsmDistrictBoundaryLayerRef.current = null; }
        if (lsmPopupRef.current) { map.closePopup(lsmPopupRef.current); lsmPopupRef.current = null; }
      }
      
      setLsmSelectedState('');
      setLsmTempDistrict('');
      setLsmSelectedDistrict(null);
      setLsmDistrictStats({ '1': 12.9, '2': 24.2, '3': 27.0, '4': 35.9, '5': 0.0 });
      setLsmAnalyzedPercent(70);
      setLsmProbabilityStats(null);
      setLsmDistrictGeoJson(null);
      setLsmPopupCoords(null);
    }

    // Clear Deformation map layers only when leaving Deformation mode
    if (analysisMode !== "deformation") {
      const map = mapRef.current;
      if (map) {
        if (defClickMarkerRef.current) { map.removeLayer(defClickMarkerRef.current); defClickMarkerRef.current = null; }
        if (defStateHighlightRef.current) { map.removeLayer(defStateHighlightRef.current); defStateHighlightRef.current = null; }
        if (defBoundariesLayerRef.current) { map.removeLayer(defBoundariesLayerRef.current); defBoundariesLayerRef.current = null; }
        if (defPopupRef.current) { map.closePopup(defPopupRef.current); defPopupRef.current = null; }
        for (const [id, ov] of defOverlaysRef.current.entries()) {
          map.removeLayer(ov);
        }
        defOverlaysRef.current.clear();
      }
      setDefSelectedState('');
      setDefQuery(null);
    }

    // Clear Climate Anomaly Atlas selection only when leaving Climate mode
    // (the district/rainfall/temperature data itself stays cached — map layer
    // add/remove is handled by its own mount/unmount effect keyed on analysisMode).
    if (analysisMode !== "climate") {
      if (climateSelectedLayerRef.current) {
        climateSelectedLayerRef.current.setStyle({ weight: 0.3, color: "rgba(33,43,54,0.25)" });
        climateSelectedLayerRef.current = null;
      }
      setClimateSelectedDistrict(null);
      setClimateSelectedState(null);
    }

    // Clear AWD plot selection only when leaving AWD mode (data stays cached).
    if (analysisMode !== "awd") {
      if (awdSelectedLayerRef.current) {
        awdSelectedLayerRef.current.setStyle({ weight: 0.4, color: '#11161d' });
        awdSelectedLayerRef.current = null;
      }
      setAwdSelectedFid(null);
      setAwdSearchText("");
      setAwdSearchMsg(null);
    }
  };

  const renderRasterOverlay = (relativeUrl, bbox) => {
    if (!mapRef.current) return;
    
    clearMapOverlay();
    
    const imageUrl = `${API_BASE}${relativeUrl}`;
    const bounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    
    const overlay = L.imageOverlay(imageUrl, bounds, {
      opacity: overlayOpacity,
      interactive: false
    }).addTo(mapRef.current);
    
    imageOverlayRef.current = overlay;
    mapRef.current.fitBounds(bounds);
  };

  // 2. Run Spectral Monitor algebra
  const runSpectralCalculation = async (autoStretch = false) => {
    if (!selectedSceneId) {
      showToast("Select a scene acquisition timeline first.", true);
      return;
    }
    
    setLoading(true);
    setLoadingText("Streaming COG tiles & resolving indices...");
    setSpectralResult(null);

    try {
      const payload = {
        platform,
        item_id: selectedSceneId,
        bbox: [minLon, minLat, maxLon, maxLat],
        index: spectralIndex,
        formula: customFormula,
        palette: colorPalette,
        vis_min: autoStretch ? null : (visMin !== "" ? parseFloat(visMin) : null),
        vis_max: autoStretch ? null : (visMax !== "" ? parseFloat(visMax) : null),
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/spectral/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Calculation rejected");
      }

      const data = await res.json();
      setSpectralResult(data);
      setVisMin(data.vis_min != null ? data.vis_min.toFixed(3) : "0.000");
      setVisMax(data.vis_max != null ? data.vis_max.toFixed(3) : "0.000");
      
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast("Spectral calculations compiled successfully");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLoading(false);
    }
  };

  const runTimeSeriesTrend = async () => {
    if (roiMethod === "file" && !uploadedGeoJson) {
      showToast("Upload a vector file first or choose Draw to select ROI.", true);
      return;
    }

    setTimeSeriesLoading(true);
    setLoading(true);
    setLoadingText("Streaming COG tiles & computing seasonal trends... This can take up to 20 seconds.");
    setTimeSeriesResult(null);

    try {
      const payload = {
        platform,
        bbox: [minLon, minLat, maxLon, maxLat],
        start_date: startDate,
        end_date: endDate,
        index: spectralIndex,
        formula: customFormula,
        cloud_cover: cloudCover,
        geometry: uploadedGeoJson,
        max_scenes: maxScenes
      };

      const res = await fetch(`${API_BASE}/api/spectral/time-series`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Time series trend calculation failed");
      }

      const data = await res.json();
      if (!data.timeseries || data.timeseries.length === 0) {
        throw new Error("No valid scenes processed in the selected date range.");
      }

      setTimeSeriesResult(data);
      setResultsPanelOpen(true);
      showToast("Time series trend generated successfully");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setTimeSeriesLoading(false);
      setLoading(false);
    }
  };

  // Evapotranspiration (SEBAL) — single-date actual ET (mm/day) for one Landsat-9
  // scene, using ERA5-Land overpass meteorology from Copernicus CDS.
  const runEtSingle = async () => {
    if (!selectedSceneId) {
      showToast("Query and select a Landsat-9 scene first.", true);
      return;
    }
    setEtLoading(true);
    setLoading(true);
    setLoadingText("Running SEBAL energy balance — fetching ERA5-Land from CDS (can take a minute)...");
    setEtSingleResult(null);
    try {
      const payload = {
        item_id: selectedSceneId,
        bbox: [minLon, minLat, maxLon, maxLat],
        palette: etPalette,
        vis_min: etVisMin !== "" ? parseFloat(etVisMin) : null,
        vis_max: etVisMax !== "" ? parseFloat(etVisMax) : null,
        geometry: uploadedGeoJson
      };
      const res = await fetch(`${API_BASE}/api/et/single`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "SEBAL evapotranspiration failed");
      }
      const data = await res.json();
      setEtSingleResult(data);
      if (data.vis_min != null) setEtVisMin(data.vis_min.toFixed(2));
      if (data.vis_max != null) setEtVisMax(data.vis_max.toFixed(2));
      renderRasterOverlay(data.image_url, data.bbox || [minLon, minLat, maxLon, maxLat]);
      setResultsPanelOpen(true);
      showToast(`ET map ready for ${data.date} (mean ${(data.stats?.mean ?? 0).toFixed(2)} mm/day)`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setEtLoading(false);
      setLoading(false);
    }
  };

  // Evapotranspiration (SEBAL) — seasonal ETa trend across Landsat-9 scenes.
  // Each date triggers a separate (slow) ERA5-Land retrieval, so scenes are capped.
  const runEtSeries = async () => {
    if (roiMethod === "file" && !uploadedGeoJson) {
      showToast("Upload a vector file first or choose Draw to select ROI.", true);
      return;
    }
    setEtLoading(true);
    setLoading(true);
    setLoadingText("Computing SEBAL ET per scene — each date fetches ERA5-Land from CDS; this can take a few minutes...");
    setEtSeriesResult(null);
    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        start_date: startDate,
        end_date: endDate,
        geometry: uploadedGeoJson,
        max_scenes: etMaxScenes
      };
      const res = await fetch(`${API_BASE}/api/et/time-series`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "ET time series failed");
      }
      const data = await res.json();
      if (!data.timeseries || data.timeseries.length === 0) {
        throw new Error("No Landsat-9 scenes could be processed in the selected range.");
      }
      setEtSeriesResult(data);
      setResultsPanelOpen(true);
      const skipped = (data.skipped || []).length;
      showToast(`ET trend ready: ${data.timeseries.length} scene(s)` + (skipped ? `, ${skipped} skipped` : ""));
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setEtLoading(false);
      setLoading(false);
    }
  };

  // Render the SEBAL ET map for one scene picked from the trend table.
  const loadSpecificEtScene = async (sceneId, date) => {
    setLoading(true);
    setLoadingText(`Computing SEBAL ET for ${date} — fetching ERA5-Land from CDS...`);
    try {
      const payload = {
        item_id: sceneId,
        bbox: [minLon, minLat, maxLon, maxLat],
        palette: etPalette,
        vis_min: etVisMin !== "" ? parseFloat(etVisMin) : null,
        vis_max: etVisMax !== "" ? parseFloat(etVisMax) : null,
        geometry: uploadedGeoJson
      };
      const res = await fetch(`${API_BASE}/api/et/single`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "SEBAL ET failed for this scene");
      }
      const data = await res.json();
      setSelectedSceneId(sceneId);
      setEtSingleResult(data);
      renderRasterOverlay(data.image_url, data.bbox || [minLon, minLat, maxLon, maxLat]);
      showToast(`ET map for ${date}: mean ${(data.stats?.mean ?? 0).toFixed(2)} mm/day`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLoading(false);
    }
  };

  const loadSpecificSceneRaster = async (sceneId, date) => {
    setLoading(true);
    setLoadingText(`Retrieving raster overlay for ${date}...`);
    try {
      const payload = {
        platform,
        item_id: sceneId,
        bbox: [minLon, minLat, maxLon, maxLat],
        index: spectralIndex,
        formula: customFormula,
        palette: colorPalette,
        vis_min: visMin !== "" ? parseFloat(visMin) : null,
        vis_max: visMax !== "" ? parseFloat(visMax) : null,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/spectral/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Raster compilation failed");
      }

      const data = await res.json();
      setSpectralResult(data);
      setVisMin(data.vis_min != null ? data.vis_min.toFixed(3) : "0.000");
      setVisMax(data.vis_max != null ? data.vis_max.toFixed(3) : "0.000");
      
      // Update selected scene metadata to reflect the selected date
      setSelectedSceneId(sceneId);
      
      // Update footer metadata display manually as well to be responsive
      let sensorName = "Sentinel-2 MSI";
      let resVal = "10 m";
      if (platform.includes("Landsat")) {
        sensorName = "Landsat C2 L2";
        resVal = "30 m";
      } else if (platform.includes("Sentinel-1")) {
        sensorName = "Sentinel-1 SAR";
        resVal = "10 m";
      }
      const matchedScene = scenes.find(s => s.id === sceneId);
      setSelectedSceneMeta({
        sensor: sensorName,
        resolution: resVal,
        date: date,
        cloudCover: matchedScene?.cloud_cover != null ? `${matchedScene.cloud_cover.toFixed(1)}%` : "0.0%",
        sceneId: sceneId,
        orbit: matchedScene?.properties?.["sat:relative_orbit"] || sceneId.split("_")[4] || "N/A"
      });

      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`Loaded map overlay for ${date}`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLoading(false);
    }
  };

  // LULC Mapping calculation
  const runLulcCalculation = async () => {
    setLulcLoading(true);
    setLoading(true);
    setLoadingText(`Fetching ML Based LULC for ${lulcYear}...`);
    setLulcResult(null);

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        dataset: lulcDataset,
        year: lulcYear,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/lulc/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "LULC calculation failed");
      }

      const data = await res.json();
      setLulcResult(data);
      setResultsPanelOpen(true);

      // Render the colorized classification on the map
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`LULC map generated for ${lulcYear}`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setLulcLoading(false);
      setLoading(false);
    }
  };

  // AEF AI Clustering calculation
  const runAefClustering = async () => {
    setAefLoading(true);
    setLoading(true);
    setLoadingText(`Running AI Clustering using AlphaEarth Embeddings for ${aefYear}...`);
    setAefResult(null);
    setCustomClusterNames({});

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        year: aefYear,
        num_clusters: aefClusters,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/aef/cluster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "AI Clustering failed");
      }

      const data = await res.json();
      setAefResult(data);
      setResultsPanelOpen(true);

      // Render the colorized classification on the map
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`AI Clustering completed with ${aefClusters} classes`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setAefLoading(false);
      setLoading(false);
    }
  };

  // AEF AI Similarity calculation
  const runAefSimilarity = async () => {
    if (!uploadedGeoJson) {
      showToast("Draw or select a Target ROI first.", true);
      return;
    }
    if (!queryGeometry) {
      showToast("Please draw a Query Feature polygon inside the ROI first.", true);
      return;
    }

    setSimilarityLoading(true);
    setLoading(true);
    setLoadingText(`Calculating AI Similarity using AlphaEarth Embeddings for ${aefYear}...`);
    setSimilarityResult(null);

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        year: aefYear,
        query_geometry: queryGeometry,
        threshold: aefThreshold,
        mode: aefSimMode,
        geometry: uploadedGeoJson,
        palette: colorPalette
      };

      const res = await fetch(`${API_BASE}/api/aef/similarity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "AI Similarity calculation failed");
      }

      const data = await res.json();
      setSimilarityResult(data);
      setResultsPanelOpen(true);

      // Render the colorized similarity map on the map
      renderRasterOverlay(data.image_url, [minLon, minLat, maxLon, maxLat]);
      showToast(`AI Similarity Search completed successfully`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setSimilarityLoading(false);
      setLoading(false);
    }
  };

  // Flood Detection (Sentinel-1 SAR) — same methodology as flood.py, but the
  // pre/post windows are user-supplied date ranges and the single scene closest
  // to the event date in each range is used (no multi-scene compositing).
  const runFloodDetection = async () => {
    if (floodPreStart > floodPreEnd) {
      showToast("Pre-event start date must be on or before its end date.", true);
      return;
    }
    if (floodPostStart > floodPostEnd) {
      showToast("Post-event start date must be on or before its end date.", true);
      return;
    }

    setFloodLoading(true);
    setLoading(true);
    setLoadingText("Streaming Sentinel-1 SAR scenes & computing backscatter change...");
    setFloodResult(null);

    try {
      const payload = {
        bbox: [minLon, minLat, maxLon, maxLat],
        pre_start: floodPreStart,
        pre_end: floodPreEnd,
        post_start: floodPostStart,
        post_end: floodPostEnd,
        orbit: floodOrbit,
        threshold_db: floodThreshold,
        geometry: uploadedGeoJson
      };

      const res = await fetch(`${API_BASE}/api/flood/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Flood detection failed");
      }

      const data = await res.json();
      setFloodResult(data);
      setResultsPanelOpen(true);

      // Show before/after scenes split by the on-map vertical swipe (divider
      // centered), with the red flood extent overlaid on the post-event side.
      setFloodSwipeX(0.5);
      floodSwipeXRef.current = 0.5;
      setFloodShowMask(true);
      setupFloodOverlays(data);
      showToast(`Flood map ready: ${data.pre_date} → ${data.post_date}`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      setFloodLoading(false);
      setLoading(false);
    }
  };

  // Reset overlays on mode switch
  useEffect(() => {
    handleClearAll();
  }, [analysisMode]);

  // Export metadata as JSON file
  const exportSceneMetadata = () => {
    if (!selectedSceneMeta) {
      showToast("No active scene selected.", true);
      return;
    }
    const sceneObject = scenes.find(s => s.id === selectedSceneId);
    const jsonStr = JSON.stringify(sceneObject || selectedSceneMeta, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Metadata_${selectedSceneMeta.sceneId}.json`;
    a.click();
    showToast("Metadata exported successfully");
  };



  // Color bar hex colors for map overlay legends
  const getPaletteGradientString = () => {
    const list = get_color_palette(colorPalette);
    return `linear-gradient(90deg, ${list.join(', ')})`;
  };

  const activeTiffUrl =
    analysisMode === "aef" && aefResult ? aefResult.geotiff_url :
    analysisMode === "lulc" && lulcResult ? lulcResult.geotiff_url :
    analysisMode === "similarity" && similarityResult ? similarityResult.geotiff_url :
    analysisMode === "flood" && floodResult ? floodResult.geotiff_url :
    (analysisMode === "et" || analysisMode === "et_timeseries") && etSingleResult ? etSingleResult.geotiff_url :
    spectralResult ? spectralResult.geotiff_url : null;

  // Double-click-to-zoom is disabled for every mode with a query-on-dblclick
  // feature (this tool's generic point query, or LSM's own), so the click
  // reaches our handler instead of zooming the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !DBLCLICK_ZOOM_DISABLED_MODES.includes(analysisMode)) return;
    map.doubleClickZoom.disable();
    return () => map.doubleClickZoom.enable();
  }, [analysisMode]);

  // Double-click a point on the map to fetch this tool's index/value there —
  // works for every result that persists a queryable GeoTIFF server-side
  // (Single Scene Scan, LULC, AI Clustering, AI Similarity, ET, Flood).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !GENERIC_QUERY_MODES.includes(analysisMode) || !activeTiffUrl) return;

    const describeValue = (value) => {
      if (value === null || value === undefined) {
        return `<div class="pop-none">No data at this point</div>`;
      }

      let label = "Value";
      let valueText = value.toFixed(4);
      let badge = null;

      if (analysisMode === "single") {
        label = `${spectralIndex} Value`;
      } else if (analysisMode === "lulc") {
        label = "Land Cover Class";
        const info = lulcResult?.legend?.[String(Math.round(value))];
        valueText = info ? info.name : `Class ${Math.round(value)}`;
        if (info) badge = { text: info.name, color: info.color };
      } else if (analysisMode === "aef") {
        label = "Cluster";
        const classVal = String(Math.round(value));
        const info = aefResult?.stats?.[classVal];
        const name = customClusterNames[classVal] || info?.name || `Cluster ${classVal}`;
        valueText = name;
        if (info) badge = { text: name, color: info.color };
      } else if (analysisMode === "similarity") {
        label = "Similarity Score";
        valueText = value.toFixed(3);
      } else if (analysisMode === "et") {
        label = "ETa (mm/day)";
        valueText = value.toFixed(2);
      } else if (analysisMode === "flood") {
        const threshold = floodResult?.stats?.threshold_db ?? 3;
        label = "Backscatter Drop (dB)";
        valueText = value.toFixed(2);
        badge = value > threshold
          ? { text: "Flooded", color: "#2d7ff9" }
          : { text: "Not Flooded", color: "#919eab" };
      }

      const badgeHtml = badge
        ? `<div class="result-badge-container"><span class="result-badge" style="background:${badge.color}22;color:${badge.color};">${badge.text}</span></div>`
        : '';

      return `
        <div class="popup-result">
          <div class="result-label">${label}</div>
          <div class="result-value">${valueText}</div>
          ${badgeHtml}
        </div>`;
    };

    const onDblClick = (e) => {
      const { lat, lng } = e.latlng;
      const coordsHtml = `<div class="popup-coordinates">${lat.toFixed(5)}° N, ${lng.toFixed(5)}° E</div><hr class="popup-divider" />`;

      const popup = L.popup({ className: 'custom-popup' })
        .setLatLng([lat, lng])
        .setContent(`
          <div class="popup-container">
            ${POPUP_HEADER_HTML}
            ${coordsHtml}
            <div class="popup-loading">
              <div class="skeleton-bar"></div>
              <div class="skeleton-bar narrow"></div>
            </div>
          </div>
        `)
        .openOn(map);

      const filename = activeTiffUrl.split('/').pop();

      fetch(`${API_BASE}/api/point-query?filename=${encodeURIComponent(filename)}&lat=${lat}&lon=${lng}`)
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || "Point query failed");
          return data;
        })
        .then((data) => {
          if (!popup.isOpen()) return;
          popup.setContent(`
            <div class="popup-container">
              ${POPUP_HEADER_HTML}
              ${coordsHtml}
              ${describeValue(data.value)}
            </div>
          `);
        })
        .catch((err) => {
          if (!popup.isOpen()) return;
          popup.setContent(`
            <div class="popup-container">
              ${POPUP_HEADER_HTML}
              ${coordsHtml}
              <div class="pop-none">${err.message || "Query failed"}</div>
            </div>
          `);
        });
    };

    map.on('dblclick', onDblClick);
    return () => map.off('dblclick', onDblClick);
  }, [analysisMode, activeTiffUrl, lulcResult, aefResult, floodResult, spectralIndex, customClusterNames]);

  // Two top-level feature groups shown in the header (H1); the active group's
  // sub-features are listed in the left sidebar.
  const FEATURE_GROUPS = [
    { id: "monitoring", label: "Monitoring & Analysis", icon: Layers, features: [
      { value: "single", label: "Single Scene Scan" },
      { value: "timeseries", label: "Seasonal Trend" },
      { value: "lulc", label: "LULC Mapping" },
      { value: "aef", label: "AI Clustering (AEF)" },
      { value: "similarity", label: "AI Similarity (AEF)" },
      { value: "et", label: "Evapotranspiration (SEBAL)" },
    ] },
    { id: "disaster", label: "Disaster Management", icon: AlertTriangle, features: [
      { value: "flood", label: "Flood Detection (SAR)" },
      { value: "lsm", label: "Landslide Susceptibility Map" },
      { value: "deformation", label: "Deformation Rate Map" },
    ] },
    { id: "climate", label: "Climate Anomaly Atlas", icon: CloudRain, features: [
      { value: "climate", label: "Climate Anomaly Atlas" },
    ] },
    { id: "awd", label: "AWD & Flooding Plots", icon: Sprout, features: [
      { value: "awd", label: "AWD & Flooding Plots" },
    ] },
  ];
  const groupOfMode = (m) => {
    if (["flood", "lsm", "deformation"].includes(m)) return "disaster";
    if (m === "climate") return "climate";
    if (m === "awd") return "awd";
    return "monitoring";
  };
  const currentGroupId = groupOfMode(analysisMode);
  const currentGroup = FEATURE_GROUPS.find(g => g.id === currentGroupId);

  const selectFeature = (value) => {
    if (value === analysisMode) return;
    if (value === "et") setPlatform("Landsat 9 (Optical)");  // SEBAL needs Landsat-9 thermal
    setAnalysisMode(value);
    handleClearAll();
  };
  const selectGroup = (gid) => {
    if (gid === currentGroupId) return;
    const g = FEATURE_GROUPS.find(x => x.id === gid);
    if (g) selectFeature(g.features[0].value);   // jump to the group's first tool
  };

  return (
    <div className="app-viewport">
      
      {/* Dynamic Alert Toast */}
      {toast && (
        <div className={`toast-msg ${toast.isError ? 'error' : ''}`}>
          {toast.isError ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Loading overlay panel */}
      {loading && (
        <div className="loading-overlay">
          <div className="scan-panel">
            <div className="scan-satellite-track">
              <Satellite size={16} className="scan-satellite-icon" />
            </div>
            <div className="scan-stage">
              <div className="scan-grid">
                {Array.from({ length: 24 }).map((_, i) => (
                  <span
                    key={i}
                    className="scan-cell"
                    style={{ animationDelay: `${(i % 6) * 90 + Math.floor(i / 6) * 140}ms` }}
                  />
                ))}
              </div>
              <div className="scan-beam"></div>
            </div>
          </div>
          <div className="loading-text">{loadingText}</div>
          <div className="loading-steps">
            {LOAD_STAGES.map((label, i) => (
              <div key={label} className={`load-step ${i <= loadingStage ? 'active' : ''}`}>
                <span className="step-dot"></span> {label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* APP HEADER */}
      <header className="hud-header">
        <div className="hud-title">
          <span className="logo-chip">
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="PhytoLens Logo" className="hud-logo-img" />
          </span>
        </div>

        <div
          ref={modeDropdownRef}
          style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', zIndex: 1001 }}
        >
          <div className="appbar-tab-group">
            {FEATURE_GROUPS.map((g, i) => {
              const active = currentGroupId === g.id;
              const GIcon = g.icon;
              return (
                <React.Fragment key={g.id}>
                  {i > 0 && <span className="appbar-tab-sep">/</span>}
                  <button
                    onClick={() => selectGroup(g.id)}
                    className={`appbar-tab ${active ? 'active' : ''}`}
                  >
                    <GIcon size={13} />
                    {g.label}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Global Map Controls */}
          <div className="flex items-center gap-3 bg-slate-900/40 px-3 py-1.5 rounded border border-cyan-500/10" style={{ position: 'relative' }}>
            <div className="dropdown-parent">
              <button
                onClick={() => setShowLsmLayersDropdown(!showLsmLayersDropdown)}
                className={`pill-btn ${showLsmLayersDropdown ? 'active' : ''}`}
                style={{ padding: '4px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <Layers size={10} /> Overlays
              </button>
              {showLsmLayersDropdown && (
                <div className="pill-dropdown-menu">
                  {analysisMode === "lsm" && (
                    <>
                      <div className="dropdown-title">Select Overlay</div>
                      <label className="dropdown-option">
                        <input
                          type="radio"
                          name="lsmOverlay"
                          checked={activeLsmOverlay === 'probability'}
                          onChange={() => {
                            setActiveLsmOverlay('probability');
                            setShowLsmLayersDropdown(false);
                          }}
                        />
                        <span>Susceptibility Heatmap</span>
                      </label>
                      <label className="dropdown-option">
                        <input
                          type="radio"
                          name="lsmOverlay"
                          checked={activeLsmOverlay === 'classes'}
                          onChange={() => {
                            setActiveLsmOverlay('classes');
                            setShowLsmLayersDropdown(false);
                          }}
                        />
                        <span>Susceptibility Classes</span>
                      </label>
                      <label className="dropdown-option">
                        <input
                          type="radio"
                          name="lsmOverlay"
                          checked={activeLsmOverlay === 'none'}
                          onChange={() => {
                            setActiveLsmOverlay('none');
                            setShowLsmLayersDropdown(false);
                          }}
                        />
                        <span>None</span>
                      </label>
                      <div className="dropdown-title" style={{ marginTop: '6px' }}>Features</div>
                    </>
                  )}
                  <label className="dropdown-option">
                    <input
                      type="checkbox"
                      checked={showHighways}
                      onChange={() => setShowHighways(!showHighways)}
                    />
                    <span>National Highways</span>
                  </label>
                </div>
              )}
            </div>
            <div style={{ borderLeft: '1px solid var(--border-color)', height: '14px', margin: '0 4px' }}></div>
            <span className="text-[10px] text-slate-500 font-bold select-none">OPACITY:</span>
            <input 
              type="range" min="0.1" max="1.0" step="0.1" 
              value={overlayOpacity} 
              onChange={e => setOverlayOpacity(parseFloat(e.target.value))} 
              style={{ width: '60px', accentColor: 'var(--accent-sky)', cursor: 'pointer' }} 
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              className="icon-btn-round"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle color theme"
              onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>

            <div className="hud-profile-badge" title="User Profile: Nitesh Kumar">
              NK
            </div>
          </div>
        </div>
      </header>

      {/* Main Workspace layout */}
      <div className="app-container">
        
        {/* LEFT CONTROL SIDEBAR */}
        <aside className="sidebar">

          {/* CARD 1: FEATURE SELECT — sub-features of the active header group */}
          <div className="sidebar-card">
            <div className="card-header">
              {(() => { const GIcon = currentGroup.icon; return <GIcon className="icon" />; })()}
              <h2>{currentGroup.label}</h2>
            </div>
            {currentGroup.features.length > 1 && (
              <div className="card-body">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Active Tool</label>
                  <div className="custom-select">
                    <select
                      value={analysisMode === "et_timeseries" ? "et" : analysisMode}
                      onChange={e => selectFeature(e.target.value)}
                    >
                      {currentGroup.features.map(f => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* CARD 2: TARGET ROI CONFIGURATION */}
          {(analysisMode !== "lsm" && analysisMode !== "deformation" && analysisMode !== "climate" && analysisMode !== "awd") && (
          <div className="sidebar-card">
            <div className="card-header">
              <Compass className="icon" />
              <h2>TARGET ROI</h2>
            </div>
            <div className="card-body">
              {/* Two-button ROI method selector */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  onClick={() => { stopDrawMode(); setRoiMethod('file'); }}
                  className={`radio-button flex-1 justify-center ${roiMethod === 'file' ? 'active' : ''}`}
                  style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                >
                  <Upload size={13} /> Upload
                </button>
                <button
                  onClick={isDrawing ? stopDrawMode : () => startDrawMode("roi")}
                  className={`radio-button flex-1 justify-center ${roiMethod === 'draw' ? 'active' : ''} ${isDrawing ? 'active' : ''}`}
                  style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                >
                  <PenTool size={13} /> {isDrawing ? 'Drawing...' : 'Draw'}
                </button>
              </div>

              {/* File Upload Section */}
              {roiMethod === "file" && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <div className="file-upload-box">
                    <input type="file" accept=".kml,.geojson,.json" onChange={handleFileUpload} className="file-upload-input" />
                    <Upload size={16} className="text-cyan-400 mb-1" />
                    <span className="file-upload-text">{uploadedFileName || "Click to browse vector"}</span>
                    <span className="file-upload-subtext">Supports .kml, .geojson, .json</span>
                  </div>
                </div>
              )}

              {/* Draw mode active indicator */}
              {roiMethod === "draw" && (
                <div className="p-2 bg-slate-900/40 border border-cyan-500/10 rounded flex items-center gap-2" style={{ marginBottom: 0 }}>
                  {isDrawing ? (
                    <>
                      <span className="badge-pulse"></span>
                      <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">Click on map to draw polygon vertices</span>
                      <button onClick={stopDrawMode} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-red)', padding: '2px' }}>
                        <X size={14} />
                      </button>
                    </>
                  ) : (
                    <span className="text-[10px] text-slate-400">
                      ROI: {minLat.toFixed(4)}°N, {minLon.toFixed(4)}°E → {maxLat.toFixed(4)}°N, {maxLon.toFixed(4)}°E
                    </span>
                  )}
                </div>
              )}

              {/* Show loaded file info */}
              {roiMethod === "file" && uploadedFileName && (
                <div className="flex items-center gap-2 text-[10px] text-slate-400" style={{ marginTop: '-4px' }}>
                  <FileCheck size={12} className="text-cyan-400" />
                  <span className="text-white font-bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uploadedFileName}</span>
                </div>
              )}
            </div>
          </div>
          )}

          {/* CARD 3: SATELLITE SCENE TIMELINE — hidden in LULC/AEF/Similarity mode */}
          {(analysisMode !== "lulc" && analysisMode !== "aef" && analysisMode !== "similarity" && analysisMode !== "flood" && analysisMode !== "lsm" && analysisMode !== "deformation" && analysisMode !== "climate" && analysisMode !== "awd") && (
          <div className="sidebar-card">
            <div className="card-header">
              <Calendar className="icon" />
              <h2>SCENE ACQUISITION</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Satellite Network</label>
                <div className="custom-select">
                  <select 
                    value={platform} 
                    onChange={e => {
                      setPlatform(e.target.value);
                      setSelectedSceneId("");
                      setScenes([]);
                    }} 
                  >
                    {/* SEBAL needs a thermal band — Sentinel-2 has none, so it is
                        not offered for Evapotranspiration. */}
                    {!(analysisMode === "et" || analysisMode === "et_timeseries") && (
                      <option value="Sentinel-2 (Optical)">Sentinel-2 MSI</option>
                    )}
                    <option value="Landsat 8 (Optical)">Landsat 8 C2 L2</option>
                    <option value="Landsat 9 (Optical)">Landsat 9 C2 L2</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="form-group">
                  <label>Start Date</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-cyber" />
                </div>
                <div className="form-group">
                  <label>End Date</label>
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="input-cyber" />
                </div>
              </div>

              <div className="form-group">
                <label>Cloud Tolerance ({cloudCover}%)</label>
                <input type="range" min="0" max="100" value={cloudCover} onChange={e => setCloudCover(parseInt(e.target.value))} />
              </div>

              <button 
                onClick={triggerStacSearch} 
                disabled={searchLoading} 
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2"
              >
                <RefreshCw className={searchLoading ? "animate-spin" : ""} size={12} />
                {searchLoading ? "Querying STAC..." : "Query Satellite Items"}
              </button>

              {(analysisMode === "single" || analysisMode === "et") && scenes.length > 0 && (
                <div className="form-group mt-2">
                  <label>Select Scene Timeline ({scenes.length})</label>
                  <div className="custom-select">
                    <select 
                      value={selectedSceneId} 
                      onChange={e => {
                        setSelectedSceneId(e.target.value);
                        clearMapOverlay();
                      }} 
                      className="font-mono text-xs"
                    >
                      {scenes.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.date} - {s.id.substring(0, 15)}... {s.cloud_cover !== null ? `(${s.cloud_cover.toFixed(0)}% Cloud)` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {analysisMode === "timeseries" && (
                <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                  <span className="text-cyan-400 font-bold uppercase tracking-wider">Seasonal Trend Query</span>
                  <p className="leading-relaxed text-slate-400">
                    No single scene selection needed. The system will extract & compute statistics for all clear satellite captures within the selected season.
                  </p>
                </div>
              )}

              {analysisMode === "et_timeseries" && (
                <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                  <span className="text-cyan-400 font-bold uppercase tracking-wider">ET Trend Query</span>
                  <p className="leading-relaxed text-slate-400">
                    No single scene selection needed. SEBAL ET is computed for Landsat-9 scenes across the season (all scenes eligible; cloud % is reported per point).
                  </p>
                </div>
              )}
            </div>
          </div>
          )}

          {/* CARD 3b: LULC CONFIGURATION — visible only in LULC mode */}
          {analysisMode === "lulc" && (
          <div className="sidebar-card">
            <div className="card-header">
              <MapPin className="icon" />
              <h2>LULC CONFIGURATION</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Year</label>
                <div className="custom-select">
                  <select value={lulcYear} onChange={e => setLulcYear(parseInt(e.target.value))}>
                    <option value={2021}>2021</option>
                  </select>
                </div>
              </div>

              <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">
                  ML Based LULC
                </span>
                <p className="leading-relaxed text-slate-400">
                  Sentinel-1 &amp; Sentinel-2 derived 11-class land cover map at 10 m resolution using machine learning classification.
                </p>
              </div>

              <button 
                onClick={runLulcCalculation} 
                disabled={lulcLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <MapPin size={12} className={lulcLoading ? "animate-spin" : ""} />
                {lulcLoading ? "Generating LULC Map..." : "Generate LULC Map"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 3c: AEF CLUSTERING CONFIGURATION — visible only in AEF mode */}
          {analysisMode === "aef" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Cpu className="icon" />
              <h2>AI CLUSTERING</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Acquisition Year</label>
                <div className="custom-select">
                  <select value={aefYear} onChange={e => setAefYear(parseInt(e.target.value))}>
                    <option value={2025}>2025 (Embeddings)</option>
                    <option value={2024}>2024 (Embeddings)</option>
                    <option value={2023}>2023 (Embeddings)</option>
                    <option value={2022}>2022 (Embeddings)</option>
                    <option value={2019}>2019 (Embeddings)</option>
                    <option value={2018}>2018 (Embeddings)</option>
                    <option value={2017}>2017 (Embeddings)</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Number of Clusters ({aefClusters})</label>
                <input 
                  type="range" 
                  min="2" 
                  max="10" 
                  value={aefClusters} 
                  onChange={e => setAefClusters(parseInt(e.target.value))} 
                />
              </div>

              <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">
                  AlphaEarth Foundations (AEF)
                </span>
                <p className="leading-relaxed text-slate-400">
                  Performs unsupervised K-Means clustering on Google DeepMind's 64-dimensional satellite embeddings sourced from the AWS opendata bucket.
                </p>
              </div>

              <button 
                onClick={runAefClustering} 
                disabled={aefLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <Cpu size={12} className={aefLoading ? "animate-spin" : ""} />
                {aefLoading ? "Clustering Embeddings..." : "Generate AI Clusters"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 3d: AI SIMILARITY CONFIGURATION — visible only in similarity mode */}
          {analysisMode === "similarity" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Cpu className="icon" />
              <h2>AI SIMILARITY</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Acquisition Year</label>
                <div className="custom-select">
                  <select value={aefYear} onChange={e => setAefYear(parseInt(e.target.value))}>
                    <option value={2025}>2025 (Embeddings)</option>
                    <option value={2024}>2024 (Embeddings)</option>
                    <option value={2023}>2023 (Embeddings)</option>
                    <option value={2022}>2022 (Embeddings)</option>
                    <option value={2019}>2019 (Embeddings)</option>
                    <option value={2018}>2018 (Embeddings)</option>
                    <option value={2017}>2017 (Embeddings)</option>
                  </select>
                </div>
              </div>

              {/* Draw Query Feature Button */}
              <div className="form-group">
                <label>Query Feature Geometry</label>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={isDrawing ? stopDrawMode : () => startDrawMode("query")}
                    className={`radio-button w-full justify-center ${drawingTarget === 'query' && isDrawing ? 'active' : ''}`}
                    style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                  >
                    <PenTool size={13} /> {drawingTarget === 'query' && isDrawing ? 'Drawing Feature...' : 'Draw Query Feature'}
                  </button>

                  <div className="flex items-center gap-2 text-[9px] text-slate-600 uppercase tracking-wider">
                    <div className="flex-1 h-px bg-slate-700/60" /> or <div className="flex-1 h-px bg-slate-700/60" />
                  </div>

                  <div className="file-upload-box" style={{ padding: '8px' }}>
                    <input type="file" accept=".kml,.geojson,.json" onChange={handleQueryFileUpload} className="file-upload-input" />
                    <Upload size={14} className="text-amber-400 mb-1" />
                    <span className="file-upload-text">Upload Query Feature</span>
                    <span className="file-upload-subtext">Supports .kml, .geojson, .json</span>
                  </div>

                  {queryFileName ? (
                    <div className="flex items-center gap-2 text-[10px] text-slate-400 p-1.5 bg-slate-900/40 rounded border border-amber-500/20">
                      <FileCheck size={12} className="text-amber-500" />
                      <span className="text-white font-bold truncate">{queryFileName}</span>
                      <button
                        onClick={() => { setQueryGeometry(null); setQueryFileName(""); }}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <span className="text-[9px] text-slate-500">No query feature yet. Draw or upload a small area inside the ROI.</span>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label>Color Palette</label>
                <div className="custom-select">
                  <select value={colorPalette} onChange={e => setColorPalette(e.target.value)}>
                    <option value="Viridis (Sequential)">Viridis (Sequential)</option>
                    <option value="Magma (Sequential)">Magma (Sequential)</option>
                    <option value="Plasma (Sequential)">Plasma</option>
                    <option value="Turbo (Rainbow Enhanced)">Turbo (Rainbow)</option>
                    <option value="Terrain (Elevation)">Terrain (Elevation)</option>
                    <option value="Red-Yellow-Green (Vegetation)">Red-Yellow-Green (Veg)</option>
                    <option value="Blue-White-Green (Water/Veg)">Blue-White-Green (Water)</option>
                    <option value="Blue-Yellow-Red (Thermal)">Blue-Yellow-Red (Thermal)</option>
                    <option value="Greyscale">Greyscale</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Similarity Mode</label>
                <div className="custom-select">
                  <select
                    value={aefSimMode}
                    onChange={e => {
                      const m = e.target.value;
                      setAefSimMode(m);
                      // Reset threshold to the mode's sensible default
                      setAefThreshold(m === "dotproduct" ? 0.9 : 0.5);
                    }}
                  >
                    <option value="centered">Local Contrast (recommended)</option>
                    <option value="dotproduct">Absolute / Dot-product (Google)</option>
                  </select>
                </div>
                <span className="text-[9px] text-slate-400 mt-1 block">
                  {aefSimMode === "dotproduct"
                    ? "Google's raw dot-product. Best for diverse scenes; in uniform terrain distinct features (e.g. water) may rank low."
                    : "Mean-centered cosine. Removes the component all pixels share so distinct features (water, built-up) are ranked correctly."}
                </span>
              </div>

              <div className="form-group">
                <label>Similarity Threshold ({aefThreshold.toFixed(3)})</label>
                <input
                  type="range"
                  min="0.000"
                  max="1.000"
                  step="0.001"
                  value={aefThreshold}
                  onChange={e => setAefThreshold(parseFloat(e.target.value))}
                />
                <span className="text-[9px] text-slate-400 mt-1 block">
                  {aefSimMode === "dotproduct"
                    ? "Dot-product similarity (1 = identical). ~0.90 is Google's default; raise to tighten."
                    : "Centered similarity (1 = identical, 0 = ROI average). ~0.50 isolates the query feature; raise to tighten."}
                </span>
              </div>



              <button 
                onClick={runAefSimilarity} 
                disabled={similarityLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <Cpu size={12} className={similarityLoading ? "animate-spin" : ""} />
                {similarityLoading ? "Computing Similarity..." : "Run Similarity Search"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 3e: FLOOD DETECTION CONFIGURATION — visible only in flood mode */}
          {analysisMode === "flood" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Droplets className="icon" />
              <h2>FLOOD DETECTION</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Pre-Event Window</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={floodPreStart}
                    onChange={e => setFloodPreStart(e.target.value)}
                    className="input-cyber"
                  />
                  <input
                    type="date"
                    value={floodPreEnd}
                    onChange={e => setFloodPreEnd(e.target.value)}
                    className="input-cyber"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Post-Event Window</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={floodPostStart}
                    onChange={e => setFloodPostStart(e.target.value)}
                    className="input-cyber"
                  />
                  <input
                    type="date"
                    value={floodPostEnd}
                    onChange={e => setFloodPostEnd(e.target.value)}
                    className="input-cyber"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Orbit Pass</label>
                <div className="custom-select">
                  <select value={floodOrbit} onChange={e => setFloodOrbit(e.target.value)}>
                    <option value="descending">Descending</option>
                    <option value="ascending">Ascending</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Backscatter Drop Threshold ({floodThreshold.toFixed(1)} dB)</label>
                <input
                  type="range"
                  min="1.0"
                  max="8.0"
                  step="0.5"
                  value={floodThreshold}
                  onChange={e => setFloodThreshold(parseFloat(e.target.value))}
                />
                <span className="text-[9px] text-slate-400 mt-1 block">
                  Pixels darker by more than this between the two scenes are flagged as new water. ~3 dB is typical.
                </span>
              </div>

              <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">
                  Sentinel-1 GRD (SAR)
                </span>
                <p className="leading-relaxed text-slate-400">
                  Compares VV backscatter (dB) between the latest pre-event and earliest post-event scenes (the pair straddling the flood). A sharp drop, after speckle filtering, marks standing water (cloud-penetrating radar).
                </p>
              </div>

              <button
                onClick={runFloodDetection}
                disabled={floodLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <Waves size={12} className={floodLoading ? "animate-spin" : ""} />
                {floodLoading ? "Detecting Flood..." : "Detect Flood Extent"}
              </button>
            </div>
          </div>
          )}

          {/* CARD 3f: EVAPOTRANSPIRATION (SEBAL) CONFIGURATION — visible only in ET modes */}
          {(analysisMode === "et" || analysisMode === "et_timeseries") && (
          <div className="sidebar-card">
            <div className="card-header">
              <Droplets className="icon" />
              <h2>EVAPOTRANSPIRATION</h2>
            </div>
            <div className="card-body">
              {/* Single-date vs seasonal-trend toggle */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setAnalysisMode("et")}
                  className={`radio-button flex-1 justify-center ${analysisMode === "et" ? 'active' : ''}`}
                  style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                >
                  <Eye size={13} /> Single Date
                </button>
                <button
                  onClick={() => setAnalysisMode("et_timeseries")}
                  className={`radio-button flex-1 justify-center ${analysisMode === "et_timeseries" ? 'active' : ''}`}
                  style={{ padding: '8px 0', fontSize: '11px', gap: '6px' }}
                >
                  <Activity size={13} /> Time Series
                </button>
              </div>

              <div className="form-group mt-3">
                <label>Color Palette</label>
                <div className="custom-select">
                  <select value={etPalette} onChange={e => setEtPalette(e.target.value)}>
                    <option value="ET (Dry-Wet)">ET (Dry → Wet)</option>
                    <option value="Ocean (Water Depth)">Ocean (Blue)</option>
                    <option value="Viridis (Sequential)">Viridis</option>
                    <option value="Blue-Yellow-Red (Thermal)">Blue-Yellow-Red</option>
                    <option value="Turbo (Rainbow Enhanced)">Turbo (Rainbow)</option>
                  </select>
                </div>
              </div>

              {analysisMode === "et" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="form-group">
                    <label>Stretch Min</label>
                    <input type="number" step="0.5" value={etVisMin} onChange={e => setEtVisMin(e.target.value)} className="input-cyber" placeholder="auto" />
                  </div>
                  <div className="form-group">
                    <label>Stretch Max</label>
                    <input type="number" step="0.5" value={etVisMax} onChange={e => setEtVisMax(e.target.value)} className="input-cyber" placeholder="auto" />
                  </div>
                </div>
              )}

              {analysisMode === "et_timeseries" && (
                <div className="form-group">
                  <label>Max Scenes to Scan ({etMaxScenes})</label>
                  <input
                    type="range"
                    min="2"
                    max="8"
                    value={etMaxScenes}
                    onChange={e => setEtMaxScenes(parseInt(e.target.value))}
                  />
                  <span className="text-[9px] text-slate-400 mt-1 block">
                    Each date fetches ERA5-Land from Copernicus CDS (slow, queued) — keep this small. Subsamples evenly across the range.
                  </span>
                </div>
              )}

              <div className="mt-3 p-2.5 bg-slate-900/40 border border-cyan-500/10 rounded flex flex-col gap-1 text-[10px] text-slate-400">
                <span className="text-cyan-400 font-bold uppercase tracking-wider">
                  SEBAL · Landsat-9 + ERA5-Land
                </span>
                <p className="leading-relaxed text-slate-400">
                  Surface energy balance (λE = Rn − G0 − H) yields daily actual ET (mm/day). Uses Landsat-9 thermal + surface reflectance and ERA5-Land overpass meteorology. Requires a <span className="text-white font-mono">~/.cdsapirc</span> CDS key. Small ROIs work too — the hot/cold anchors are calibrated from the surrounding ~13 km and the result is cropped back to your area.
                </p>
              </div>

              <button
                onClick={analysisMode === "et" ? runEtSingle : runEtSeries}
                disabled={etLoading}
                className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-3"
              >
                <Droplets size={12} className={etLoading ? "animate-spin" : ""} />
                {etLoading
                  ? (analysisMode === "et" ? "Computing ET..." : "Computing ET Trend...")
                  : (analysisMode === "et" ? "Compute Evapotranspiration" : "Run ET Time Series")}
              </button>
            </div>
          </div>
          )}

          {/* CARD 4: ANALYTICS PARAMETERS — hidden in LULC/AEF/Similarity/Flood/ET mode */}
          {(analysisMode !== "lulc" && analysisMode !== "aef" && analysisMode !== "similarity" && analysisMode !== "flood" && analysisMode !== "et" && analysisMode !== "et_timeseries" && analysisMode !== "lsm" && analysisMode !== "deformation" && analysisMode !== "climate" && analysisMode !== "awd") && (
          <div className="sidebar-card">
            <div className="card-header">
              <Sliders className="icon" />
              <h2>PARAMETERS</h2>
            </div>
            <div className="card-body">
              <div className="flex flex-col gap-3">
                <div className="form-group">
                  <label>Spectral Index</label>
                  <div className="custom-select">
                    <select value={spectralIndex} onChange={e => setSpectralIndex(e.target.value)}>
                      <option value="NDVI">NDVI (Vegetation health)</option>
                      <option value="GNDVI">GNDVI (Chlorophyll index)</option>
                      <option value="NDWI (Water)">NDWI (Water body mapping)</option>
                      <option value="NDMI">NDMI (Moisture content)</option>
                      {platform.includes("Landsat") && <option value="LST (Thermal)">LST (Brightness Temp)</option>}
                      <option value="🛠️ Custom (Band Math)">🛠️ Custom (Band Math)</option>
                    </select>
                  </div>
                </div>

                {spectralIndex === "🛠️ Custom (Band Math)" && (
                  <div className="form-group">
                    <label>Algebra Expression</label>
                    <input type="text" value={customFormula} onChange={e => setCustomFormula(e.target.value)} className="input-cyber" />
                    <span className="text-[9px] text-slate-400 mt-1 block">e.g. (B08-B04)/(B08+B04)</span>
                  </div>
                )}

                <div className="form-group">
                  <label>Color Palette</label>
                  <div className="custom-select">
                    <select value={colorPalette} onChange={e => setColorPalette(e.target.value)}>
                      <option value="Red-Yellow-Green (Vegetation)">Red-Yellow-Green (Veg)</option>
                      <option value="Blue-White-Green (Water/Veg)">Blue-White-Green (Water)</option>
                      <option value="Blue-Yellow-Red (Thermal)">Blue-Yellow-Red (Thermal)</option>
                      <option value="Viridis (Sequential)">Viridis (Sequential)</option>
                      <option value="Magma (Sequential)">Magma (Sequential)</option>
                      <option value="Plasma (Sequential)">Plasma</option>
                      <option value="Turbo (Rainbow Enhanced)">Turbo (Rainbow)</option>
                      <option value="Terrain (Elevation)">Terrain (Elevation)</option>
                      <option value="Greyscale">Greyscale</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="form-group">
                    <label>Stretch Min</label>
                    <input type="number" step="0.1" value={visMin} onChange={e => setVisMin(e.target.value)} className="input-cyber" />
                  </div>
                  <div className="form-group">
                    <label>Stretch Max</label>
                    <input type="number" step="0.1" value={visMax} onChange={e => setVisMax(e.target.value)} className="input-cyber" />
                  </div>
                </div>

                {analysisMode === "timeseries" && (
                  <div className="form-group">
                    <label>Max Scenes to Scan ({maxScenes})</label>
                    <input 
                      type="range" 
                      min="5" 
                      max="30" 
                      value={maxScenes} 
                      onChange={e => setMaxScenes(parseInt(e.target.value))} 
                    />
                    <span className="text-[9px] text-slate-400 mt-1 block">Fewer scenes process faster. Subsamples evenly if more exist.</span>
                  </div>
                )}

                {analysisMode === "single" ? (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <button onClick={() => runSpectralCalculation(true)} className="reset-btn-pill active py-2 text-xs flex-1">
                      Auto Stretch
                    </button>
                    <button onClick={() => runSpectralCalculation(false)} className="submit-btn-pill active py-2 text-xs flex-1">
                      Scan Scene
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={runTimeSeriesTrend} 
                    disabled={timeSeriesLoading}
                    className="submit-btn-pill active py-2 text-xs w-full flex justify-center items-center gap-2 mt-1"
                  >
                    <Activity size={12} className={timeSeriesLoading ? "animate-spin" : ""} />
                    {timeSeriesLoading ? "Computing Trend..." : "Run Time Series Trend"}
                  </button>
                )}
              </div>
            </div>
          </div>
          )}

          {/* Legend removed from here and placed in footer */}

          {/* CARD 6: INFO BOX */}
          {(analysisMode !== "flood" && analysisMode !== "et" && analysisMode !== "et_timeseries" && analysisMode !== "lsm" && analysisMode !== "deformation" && analysisMode !== "climate" && analysisMode !== "awd") && (
          <div className="info-box-card">
            <Activity className="icon-info" />
            <p>
              Calculates index formulas from multispectral bands (S2/Landsat COGs) dynamically stretched over the target bounds.
            </p>
          </div>
          )}

          {/* LSM FOCUS AREA CARD */}
          {analysisMode === "lsm" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Compass className="icon" />
              <h2>FOCUS AREA</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Analysis Level</label>
                <div className="lsm-focus-toggle">
                  <button
                    className={`radio-button ${lsmFocusType === 'district' ? 'active' : ''}`}
                    onClick={() => handleLsmFocusTypeSwitch('district')}
                  >
                    District
                  </button>
                  <button
                    className={`radio-button ${lsmFocusType === 'highway' ? 'active' : ''}`}
                    onClick={() => handleLsmFocusTypeSwitch('highway')}
                  >
                    Highway
                  </button>
                </div>
              </div>

              {lsmFocusType === 'district' ? (
              <>
              <div className="form-group">
                <label>State / UT</label>
                <div className="custom-select">
                  <select value={lsmSelectedState} onChange={e => { setLsmSelectedState(e.target.value); setLsmTempDistrict(''); }}>
                    <option value="">Select State</option>
                    {lsmStates.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>District</label>
                <div className="custom-select">
                  <select
                    value={lsmTempDistrict}
                    onChange={e => setLsmTempDistrict(e.target.value)}
                    disabled={!lsmSelectedState}
                  >
                    <option value="">Select District</option>
                    {lsmDistrictsInState.map(d => (
                      <option key={d.district} value={d.district}>{d.district}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  className={`submit-btn-pill ${lsmTempDistrict && (!lsmSelectedDistrict || lsmSelectedDistrict.district !== lsmTempDistrict) ? 'active' : ''}`}
                  onClick={handleLsmSubmitFocus}
                  disabled={!lsmTempDistrict || (lsmSelectedDistrict && lsmSelectedDistrict.district === lsmTempDistrict)}
                  style={{ flex: 1.5 }}
                >
                  Apply Focus
                </button>
                <button
                  className={`reset-btn-pill ${lsmSelectedDistrict ? 'active' : ''}`}
                  onClick={handleLsmClearSelection}
                  disabled={!lsmSelectedDistrict}
                  style={{ flex: 1, padding: '0.65rem 0' }}
                >
                  Reset
                </button>
              </div>
              </>
              ) : (
              <>
              <div className="form-group">
                <label>Search Highway</label>
                <input
                  className="hwy-filter-input"
                  type="text"
                  placeholder="Type to filter — e.g. NH 44"
                  value={lsmHighwayFilter}
                  onChange={e => setLsmHighwayFilter(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>National Highway</label>
                <div className="custom-select">
                  <select
                    value={lsmTempHighway}
                    onChange={e => setLsmTempHighway(e.target.value)}
                    disabled={!lsmHighwayOptions}
                  >
                    <option value="">{lsmHighwayOptions ? 'Select Highway' : 'Loading highways…'}</option>
                    {lsmHighwayOptions && lsmHighwayOptions.nh.length > 0 && (
                      <optgroup label="National Highways">
                        {lsmHighwayOptions.nh.map(h => (
                          <option key={h.name} value={h.name}>{h.name} · {Math.round(h.total_length_km)} km</option>
                        ))}
                      </optgroup>
                    )}
                    {lsmHighwayOptions && lsmHighwayOptions.other.length > 0 && (
                      <optgroup label="Expressways & Other Roads">
                        {lsmHighwayOptions.other.map(h => (
                          <option key={h.name} value={h.name}>{h.name} · {Math.round(h.total_length_km)} km</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Corridor Buffer (each side)</label>
                <div className="custom-select">
                  <select value={lsmBufferM} onChange={e => setLsmBufferM(e.target.value)}>
                    <option value="250">250 m</option>
                    <option value="500">500 m</option>
                    <option value="1000">1 km</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  className={`submit-btn-pill ${lsmTempHighway && (!lsmSelectedHighway || lsmSelectedHighway.name !== lsmTempHighway) ? 'active' : ''}`}
                  onClick={handleLsmHighwaySubmit}
                  disabled={!lsmTempHighway || lsmHighwayLoading || (lsmSelectedHighway && lsmSelectedHighway.name === lsmTempHighway)}
                  style={{ flex: 1.5 }}
                >
                  {lsmHighwayLoading ? 'Analyzing…' : 'Apply Focus'}
                </button>
                <button
                  className={`reset-btn-pill ${lsmSelectedHighway ? 'active' : ''}`}
                  onClick={handleLsmHighwayClear}
                  disabled={!lsmSelectedHighway}
                  style={{ flex: 1, padding: '0.65rem 0' }}
                >
                  Reset
                </button>
              </div>
              </>
              )}
            </div>
          </div>
          )}

          {/* LSM SUSCEPTIBILITY OVERVIEW CARD */}
          {analysisMode === "lsm" && lsmFocusType === 'district' && (
          <div className="sidebar-card">
            <div className="card-header">
              <Activity className="icon" />
              <h2>
                SUSCEPTIBILITY OVERVIEW
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px', fontWeight: '500', textTransform: 'none', letterSpacing: 'normal' }}>
                  {lsmSelectedDistrict ? `${lsmSelectedDistrict.district}, ${lsmSelectedDistrict.state}` : 'National Overview (India)'}
                </div>
              </h2>
            </div>
            <div className="card-body">
              <DonutChart stats={lsmDistrictStats} analyzedPercent={lsmAnalyzedPercent} />
              {lsmSelectedDistrict && lsmProbabilityStats && (
                <div className="probability-stats-box">
                  <div className="prob-stat-item">
                    <span className="prob-stat-label">Min Prob</span>
                    <span className="prob-stat-value">{lsmProbabilityStats.min.toFixed(4)}</span>
                  </div>
                  <div className="prob-stat-item">
                    <span className="prob-stat-label">Mean Prob</span>
                    <span className="prob-stat-value">{lsmProbabilityStats.mean.toFixed(4)}</span>
                  </div>
                  <div className="prob-stat-item">
                    <span className="prob-stat-label">Max Prob</span>
                    <span className="prob-stat-value">{lsmProbabilityStats.max.toFixed(4)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          )}

          {/* LSM HIGHWAY RISK PROFILE CARD */}
          {analysisMode === "lsm" && lsmFocusType === 'highway' && (
          <div className="sidebar-card">
            <div className="card-header">
              <Activity className="icon" />
              <h2>
                HIGHWAY RISK PROFILE
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px', fontWeight: '500', textTransform: 'none', letterSpacing: 'normal' }}>
                  {lsmSelectedHighway ? `${lsmSelectedHighway.name} · ${lsmBufferM === '1000' ? '1 km' : `${lsmBufferM} m`} buffer` : 'No highway selected'}
                </div>
              </h2>
            </div>
            <div className="card-body">
              {!lsmSelectedHighway ? (
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>
                  Select a National Highway and apply focus to analyse landslide susceptibility along its corridor —
                  stretch-wise classes are drawn on the map and quantified here.
                </p>
              ) : (() => {
                const buf = String(lsmBufferM);
                const corridor = lsmSelectedHighway.corridor && lsmSelectedHighway.corridor[buf];
                const prob = lsmSelectedHighway.probability && lsmSelectedHighway.probability[buf];
                const lengths = lsmSelectedHighway.class_lengths_km || {};
                const stats = lsmSelectedHighway.stats || {};
                return (
                  <>
                    <div className="metric-grid" style={{ marginBottom: '12px' }}>
                      <div className="metric metric-emph">
                        <span className="metric-label">Total Length</span>
                        <span className="metric-value">
                          {Math.round(lsmSelectedHighway.total_length_km).toLocaleString()}
                          <span className="metric-unit"> km</span>
                        </span>
                      </div>
                      <div className="metric">
                        <span className="metric-label">In Study Area</span>
                        <span className="metric-value">
                          {lsmSelectedHighway.analyzed_percentage}
                          <span className="metric-unit"> %</span>
                        </span>
                      </div>
                    </div>

                    <DonutChart
                      stats={stats}
                      analyzedPercent={lsmSelectedHighway.analyzed_percentage}
                      centerLabel="Length Analysed"
                    />

                    <div className="hwy-stack-bar" title="Composition of the analysed highway length">
                      {[5, 4, 3, 2, 1].map(c => (stats[String(c)] > 0 && (
                        <span
                          key={c}
                          style={{ width: `${stats[String(c)]}%`, background: LSM_CLASS_COLORS[c] }}
                          title={`${LSM_CLASS_LABELS[c]}: ${stats[String(c)]}%`}
                        />
                      )))}
                    </div>

                    <table className="hwy-table">
                      <thead>
                        <tr>
                          <th>Class</th>
                          <th>Length</th>
                          <th title="Share of the analysed highway length">% Length</th>
                          <th title="Class composition of the buffered corridor area">% Corridor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[5, 4, 3, 2, 1].map(c => (
                          <tr key={c}>
                            <td>
                              <span className="hwy-swatch" style={{ backgroundColor: LSM_CLASS_COLORS[c] }}></span>
                              {LSM_CLASS_LABELS[c]}
                            </td>
                            <td>{(lengths[String(c)] ?? 0).toFixed(1)} km</td>
                            <td>{(stats[String(c)] ?? 0).toFixed(1)}%</td>
                            <td>{corridor ? `${(corridor.stats[String(c)] ?? 0).toFixed(1)}%` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {lsmSelectedHighway.unanalyzed_km > 0 && (
                      <div className="hwy-note">
                        {lsmSelectedHighway.unanalyzed_km.toLocaleString()} km of this highway lies outside the
                        susceptibility model's study area (dashed grey on the map).
                      </div>
                    )}

                    {prob && (
                      <div className="probability-stats-box">
                        <div className="prob-stat-item">
                          <span className="prob-stat-label">Min Prob</span>
                          <span className="prob-stat-value">{prob.min.toFixed(4)}</span>
                        </div>
                        <div className="prob-stat-item">
                          <span className="prob-stat-label">Mean Prob</span>
                          <span className="prob-stat-value">{prob.mean.toFixed(4)}</span>
                        </div>
                        <div className="prob-stat-item">
                          <span className="prob-stat-label">Max Prob</span>
                          <span className="prob-stat-value">{prob.max.toFixed(4)}</span>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
          )}


          {/* LSM INFO BOX CARD */}
          {analysisMode === "lsm" && (
          <div className="info-box-card">
            <Activity className="icon-info" />
            <p>{lsmFocusType === 'highway'
              ? 'Highway-wise analysis buffers the selected corridor and samples the susceptibility model along it: % Length is each class’s share of the analysed highway length, % Corridor its share of the buffered corridor area. Double click to query susceptibility at specific coordinates.'
              : 'This map shows landslide susceptibility based on environmental factor models and historic events. Double click to query susceptibility values at specific coordinates.'}</p>
          </div>
          )}

          {/* DEFORMATION MAP FOCUS AREA CARD */}
          {analysisMode === "deformation" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Compass className="icon" />
              <h2>FOCUS AREA</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>State / UT</label>
                <div className="custom-select">
                  <select 
                    value={defSelectedState} 
                    onChange={e => setDefSelectedState(e.target.value)}
                  >
                    <option value="">Whole Coverage (Union)</option>
                    {defStates.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              
              <button 
                className={`reset-btn-pill ${defSelectedState ? 'active' : ''}`}
                onClick={() => setDefSelectedState('')}
                disabled={!defSelectedState}
                style={{ marginTop: '4px' }}
              >
                <Compass className="reset-icon" />
                Reset View
              </button>
            </div>
          </div>
          )}

          {/* DEFORMATION MAP LAYERS CARD */}
          {analysisMode === "deformation" && defManifest && (
          <div className="sidebar-card">
            <div className="card-header">
              <Layers className="icon" />
              <h2>MAP LAYERS</h2>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {defManifest.layers.map((l) => {
                const isVisible = defVisibleLayers.has(l.id);
                const scale = defManifest.scales[l.id];
                return (
                  <div key={l.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <div 
                      className="switch-row" 
                      onClick={() => {
                        const next = new Set(defVisibleLayers);
                        next.has(l.id) ? next.delete(l.id) : next.add(l.id);
                        setDefVisibleLayers(next);
                      }}
                    >
                      <span className="switch-label">{l.name} Mosaic</span>
                      <label className="switch-control" onClick={(e) => e.stopPropagation()}>
                        <input 
                          type="checkbox" 
                          checked={isVisible} 
                          onChange={() => {
                            const next = new Set(defVisibleLayers);
                            next.has(l.id) ? next.delete(l.id) : next.add(l.id);
                            setDefVisibleLayers(next);
                          }} 
                        />
                        <span className="slider-knob"></span>
                      </label>
                    </div>
                    {isVisible && (
                      <div className="sidebar-legend">
                        <div className="sidebar-legend-title">Scale ({scale.units})</div>
                        <img src={`${import.meta.env.BASE_URL}velocity_data/data/colorbar_${l.id}.png`} alt="color scale" />
                        <div className="sidebar-legend-labels">
                          <span>{scale.vmin}</span><span>0</span><span>{scale.vmax}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* National Highways toggle switch (shared with the header Overlays dropdown) */}
              <div
                className="switch-row"
                onClick={() => setShowHighways(!showHighways)}
                style={{ marginTop: '0.25rem' }}
              >
                <span className="switch-label">National Highways</span>
                <label className="switch-control" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={showHighways}
                    onChange={() => setShowHighways(!showHighways)}
                  />
                  <span className="slider-knob"></span>
                </label>
              </div>

            </div>
          </div>
          )}

          {/* DEFORMATION POINT QUERY DETAILS CARD */}
          {analysisMode === "deformation" && defQuery && (
            <div className="sidebar-card query-card">
              <div className="card-header" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div className="logo-icon" style={{ backgroundColor: 'var(--accent-sky)', width: '8px', height: '8px' }}></div>
                  <h2 style={{ color: 'var(--accent-sky)' }}>Point Query</h2>
                </div>
                <button style={{ border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem', padding: '0 4px', lineHeights: 1 }} onClick={() => {
                  setDefQuery(null);
                  if (defClickMarkerRef.current && mapRef.current) {
                    mapRef.current.removeLayer(defClickMarkerRef.current);
                    defClickMarkerRef.current = null;
                  }
                  if (mapRef.current) mapRef.current.closePopup();
                }}>×</button>
              </div>
              <div className="card-body">
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace', fontWeight: 'bold' }}>
                  {defQuery.lat.toFixed(5)}°N, {defQuery.lng.toFixed(5)}°E
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {defQuery.hits.length === 0 ? (
                    <div className="pop-none">No spatial data at this location.</div>
                  ) : (
                    defQuery.hits.map((h) => (
                      <div key={h.id} className="pop-row" style={{ padding: '4px 0' }}>
                        <span>{h.name} Mode</span>
                        <b className={h.value < 0 ? 'neg' : 'pos'}>{h.value.toFixed(2)} mm/yr</b>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* DEFORMATION INFO CARD */}
          {analysisMode === "deformation" && (
          <div className="info-box-card">
            <Activity className="icon-info" />
            <p>
              Values represent ground deformation rates along the satellite's Line of Sight (InSAR LOS). 
              <br />
              <b style={{ color: '#72a5ff' }}>Negative values</b> indicate ground displacement moving <b>away</b> from the satellite (subsidence/downward). 
              <br />
              <b style={{ color: '#ff7c7c' }}>Positive values</b> indicate ground displacement moving <b>towards</b> the satellite (uplift/upward).
            </p>
          </div>
          )}

          {/* ================= CLIMATE ANOMALY ATLAS ================= */}
          {analysisMode === "climate" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Calendar className="icon" />
              <h2>FILTERS</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Year</label>
                <div className="custom-select">
                  <select value={climateYear ?? ""} onChange={e => setClimateYear(Number(e.target.value))} disabled={!climateAvailableYears.length}>
                    {climateAvailableYears.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Month</label>
                <div className="custom-select">
                  <select value={climateMonth ?? ""} onChange={e => setClimateMonth(Number(e.target.value))} disabled={!climateAvailableMonths.length}>
                    {climateAvailableMonths.map(m => <option key={m} value={m}>{CLIMATE_MONTH_NAMES[m - 1]}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Week</label>
                <div className="custom-select">
                  <select value={climateWeek ?? ""} onChange={e => setClimateWeek(Number(e.target.value))} disabled={!climateAvailableWeeks.length}>
                    {climateAvailableWeeks.map(w => <option key={w} value={w}>Week {w}</option>)}
                  </select>
                </div>
              </div>
              {climateWeekData && (
                <div className="period-pill">
                  <span className="period-pill-label">Reporting period</span>
                  <span className="period-pill-value">{climateFmtDate(climateWeekData.start)} → {climateFmtDate(climateWeekData.end)}</span>
                </div>
              )}

              <div className="form-group" style={{ marginTop: '0.75rem' }}>
                <label>State</label>
                <div className="custom-select">
                  <select value={climateStateFilter} onChange={e => setClimateStateFilter(e.target.value)}>
                    <option value="">All states</option>
                    {climateStatesList.map(s => <option key={s} value={s}>{climateTitleCase(s)}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>District</label>
                <div className="custom-select">
                  <select
                    value={climateSelectedDistrict ? climateLK(climateSelectedDistrict, climateSelectedState) : ""}
                    onChange={e => {
                      if (!e.target.value) return;
                      const [name, st] = e.target.value.split(CLIMATE_SEP);
                      selectClimateDistrict(name, st);
                    }}
                  >
                    <option value="">Select district</option>
                    {climateDistrictOptions.map(d => (
                      <option key={climateLK(d.name, d.state)} value={climateLK(d.name, d.state)}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
          )}

          {analysisMode === "climate" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Layers className="icon" />
              <h2>LAYERS</h2>
            </div>
            <div className="card-body">
              {["rainfall", "tmax", "tmin"].map(id => {
                const V = CLIMATE_VARIABLES[id];
                const active = id === climateVar;
                return (
                  <div key={id} className={`layer-row ${active ? 'is-active' : ''}`} onClick={() => setClimateVar(id)}>
                    <span className="layer-row-swatch" style={{ background: V.surplusColor }}></span>
                    <span className="layer-row-name">{V.label}</span>
                    {active ? <Eye size={15} className="layer-row-eye" /> : <EyeOff size={15} className="layer-row-eye" />}
                  </div>
                );
              })}
            </div>
          </div>
          )}

          {analysisMode === "climate" && (
          <div className="info-box-card">
            <Info className="icon-info" />
            <p>
              District-level deviation of weekly rainfall/temperature from a historical normal, area-weighted from IMD daily gridded data. Click a district for its trajectory.
            </p>
          </div>
          )}
          {analysisMode === "climate" && climateLoadError && (
          <div className="info-box-card" style={{ background: 'rgba(224,62,62,0.1)', border: '1px solid rgba(224,62,62,0.28)' }}>
            <AlertTriangle className="icon-info" style={{ color: 'var(--color-red)' }} />
            <p style={{ color: 'var(--color-red)' }}>{climateLoadError}</p>
          </div>
          )}

          {/* ================= AWD & FLOODING PLOTS ================= */}
          {analysisMode === "awd" && (
          <div className="sidebar-card">
            <div className="card-header">
              <Compass className="icon" />
              <h2>AWD FILTERS</h2>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label>Choose plot ID</label>
                <div className="custom-select">
                  <select value={awdSelectedFid ?? ""} onChange={e => e.target.value && selectAwdPlot(e.target.value)} disabled={!awdFidList.length}>
                    <option value="">Select plot...</option>
                    {awdFidList.map(fid => <option key={fid} value={fid}>Plot #{fid}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ textAlign: 'center', margin: '4px 0 8px', color: 'var(--text-3)', fontSize: '10px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase' }}>— OR —</div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Type plot ID (FID)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <input
                    type="text"
                    className="custom-select"
                    style={{ padding: '7px 9px' }}
                    placeholder="e.g. 3, 4, 10"
                    value={awdSearchText}
                    onChange={e => setAwdSearchText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAwdSearch(); }}
                  />
                  <button className="submit-btn-pill active" onClick={handleAwdSearch}>
                    <Search size={12} /> Search
                  </button>
                </div>
                {awdSearchMsg && (
                  <div style={{ marginTop: '6px', fontSize: '11px', color: awdSearchMsg.isError ? 'var(--color-red)' : 'var(--text-muted)', fontWeight: 600 }}>
                    {awdSearchMsg.text}
                  </div>
                )}
              </div>
            </div>
          </div>
          )}

          {analysisMode === "awd" && awdData && (
          <div className="sidebar-card">
            <div className="card-header">
              <Layers className="icon" />
              <h2>AWD LAYERS</h2>
            </div>
            <div className="card-body">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Color by variable</label>
                <div className="custom-select">
                  <select value={awdColorByKey} onChange={e => setAwdColorByKey(e.target.value)}>
                    {awdData.varDefs.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </div>
          )}

          {analysisMode === "awd" && (
          <div className="info-box-card">
            <Info className="icon-info" />
            <p>Click a plot on the map to load its Relative Water Depth Index (RWDI) history.</p>
          </div>
          )}
          {analysisMode === "awd" && awdLoadError && (
          <div className="info-box-card" style={{ background: 'rgba(224,62,62,0.1)', border: '1px solid rgba(224,62,62,0.28)' }}>
            <AlertTriangle className="icon-info" style={{ color: 'var(--color-red)' }} />
            <p style={{ color: 'var(--color-red)' }}>{awdLoadError}</p>
          </div>
          )}
        </aside>

        {/* CENTRAL MAP WORKSPACE */}
        <section className="workspace">

          <div className="map-container">
            <div id="leaflet-map" ref={mapContainerRef}></div>
          </div>

          {/* FLOOD VERTICAL SWIPE DIVIDER (on map): left = post-event, right = pre-event */}
          {analysisMode === "flood" && floodResult && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 600 }}>
              {/* Side labels */}
              <div style={{ position: 'absolute', top: '58px', left: '12px', background: 'var(--panel-bg-strong)', color: 'var(--text-main)', fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: 'var(--radius)', border: '1px solid rgba(224,62,62,0.4)', letterSpacing: '0.04em', textTransform: 'uppercase', backdropFilter: 'blur(6px)', boxShadow: 'var(--elev-2)' }}>
                ◀ Post-event · {floodResult.post_date}
              </div>
              <div style={{ position: 'absolute', top: '58px', right: '12px', background: 'var(--panel-bg-strong)', color: 'var(--text-main)', fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: 'var(--radius)', border: '1px solid rgba(11,175,175,0.4)', letterSpacing: '0.04em', textTransform: 'uppercase', backdropFilter: 'blur(6px)', boxShadow: 'var(--elev-2)' }}>
                Pre-event · {floodResult.pre_date} ▶
              </div>

              {/* Divider line + drag handle */}
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${floodSwipeX * 100}%`, width: '0px' }}>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: '-1.5px', width: '3px', background: '#ffffff', boxShadow: '0 0 8px rgba(0,0,0,0.5)' }}></div>
                <div
                  onMouseDown={(e) => { e.preventDefault(); setFloodSwipeDragging(true); }}
                  onTouchStart={() => setFloodSwipeDragging(true)}
                  title="Drag to compare pre / post event"
                  style={{
                    position: 'absolute', top: '50%', left: '0px', transform: 'translate(-50%, -50%)',
                    width: '38px', height: '38px', borderRadius: '50%',
                    background: 'var(--panel-bg-strong)', border: '2px solid var(--accent-sky)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'ew-resize', pointerEvents: 'auto', color: 'var(--text-main)', fontSize: '15px',
                    boxShadow: 'var(--elev-2)', userSelect: 'none'
                  }}
                >
                  ⟺
                </div>
              </div>
            </div>
          )}

          {/* FLOATING CONTROL OVERLAYS ON MAP */}
          <div className="map-top-bar">
            {/* Lat/Lon Search Box */}
            <form onSubmit={handleSearchSubmit} className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="search-icon" style={{ width: '16px', height: '16px', flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input 
                type="text" 
                placeholder="Search coords (lat, lon)..." 
                value={searchCoords}
                onChange={e => setSearchCoords(e.target.value)}
              />
            </form>
          </div>

          {/* Custom Vertical Map Controls on the Right */}
          <div className="custom-map-controls">
            <button className="control-btn" onClick={() => mapRef.current?.zoomIn()} title="Zoom In">+</button>
            <button className="control-btn" onClick={() => mapRef.current?.zoomOut()} title="Zoom Out">-</button>
            <div className="control-divider"></div>
            <button className="control-btn" onClick={() => {
              if (mapRef.current) {
                if (roiMethod === "file" && geoJsonLayerRef.current) {
                  mapRef.current.fitBounds(geoJsonLayerRef.current.getBounds());
                } else {
                  mapRef.current.fitBounds([[minLat, minLon], [maxLat, maxLon]]);
                }
              }
            }} title="Reset Zoom to ROI bounds">
              <Compass size={14} className="control-icon" />
            </button>
            <button className="control-btn" onClick={handleLocateClient} title="Center GPS location">
              <span style={{ fontSize: '13px' }}>🎯</span>
            </button>
            <button className="control-btn" onClick={toggleFullscreen} title="Toggle Map Fullscreen">
              <span style={{ fontSize: '13px' }}>{isFullscreen ? "🗜" : "📺"}</span>
            </button>
          </div>

          {/* Coordinate Overlay Tracker (bottom right) */}
          <div className="coordinate-overlay-pill">
            <span className="badge-pulse"></span>
            <span>
              {hoverCoords 
                ? `${hoverCoords.lat.toFixed(5)}° N, ${hoverCoords.lng.toFixed(5)}° E` 
                : `${pointLat.toFixed(5)}° N, ${pointLon.toFixed(5)}° E`}
            </span>
          </div>

          {/* ALWAYS-VISIBLE INSIGHTS PANEL — Climate Anomaly Atlas + AWD & Flooding Plots */}
          {analysisMode === "climate" && climateWeekData && (() => {
            const V = CLIMATE_VARIABLES[climateVar];
            const rec = climateSelectedDistrict ? climateWeekData.districts[climateSelectedDistrict] : null;
            const cat = rec?.[V.fields.category] || "No Data";
            const catColorVal = climateCatColor(climateVar, cat);
            return (
              <div className="insights-panel">
                <div className="stats-grid">
                  <div className="stat-card" style={{ borderTop: '3px solid #2d7ff9' }}>
                    <div className="stat-label">{V.hero.surplusLabel}</div>
                    <div className="stat-val high">{climateHeroStats.surplus}</div>
                    <div className="metric-unit">{V.hero.surplusUnit}</div>
                  </div>
                  <div className="stat-card" style={{ borderTop: '3px solid #e8a317' }}>
                    <div className="stat-label">{V.hero.deficitLabel}</div>
                    <div className="stat-val" style={{ color: 'var(--color-amber)' }}>{climateHeroStats.deficit}</div>
                    <div className="metric-unit">{V.hero.deficitUnit}</div>
                  </div>
                </div>

                <div className="sidebar-card">
                  <div className="card-header">
                    <Activity className="icon" />
                    <h2>Distribution this week</h2>
                  </div>
                  <div className="card-body">
                    <CategoryDonut
                      segments={climateDistribution.segments}
                      centerValue={`${climateDistribution.withData}`}
                      centerLabel="Districts"
                    />
                  </div>
                </div>

                {climateSelectedDistrict ? (
                  <div className="sidebar-card">
                    <div className="card-header">
                      <MapPin className="icon" />
                      <h2>{climateSelectedDistrict}{climateSelectedState ? `, ${climateTitleCase(climateSelectedState)}` : ""}</h2>
                    </div>
                    <div className="card-body">
                      <div className="metric-grid">
                        <div className="metric">
                          <span className="metric-label">Actual</span>
                          <span className="metric-value">{rec?.[V.fields.actual] == null ? "—" : Number(rec[V.fields.actual]).toFixed(1)}</span>
                          <span className="metric-unit">{V.units.actual}</span>
                        </div>
                        <div className="metric">
                          <span className="metric-label">Normal</span>
                          <span className="metric-value">{rec?.[V.fields.normal] == null ? "—" : Number(rec[V.fields.normal]).toFixed(1)}</span>
                          <span className="metric-unit">{V.units.normal}</span>
                        </div>
                        <div className="metric metric-emph">
                          <span className="metric-label">{V.measureLabel}</span>
                          <span className="metric-value">{V.formatMeasure(rec?.[V.fields.measure])}</span>
                        </div>
                        <div className="metric">
                          <span className="metric-label">Category</span>
                          <span className="metric-pill" style={{ background: catColorVal, color: climateContrastText(catColorVal) }}>{cat}</span>
                        </div>
                      </div>
                      <div className="chart-block">
                        <div className="chart-head">
                          <h3>Weekly trajectory <span className="chart-year">{climateYear}</span></h3>
                          <div className="chart-legend">
                            <span className="cl-item"><span className="cl-swatch" style={{ background: 'var(--accent-sky)' }}></span>Actual</span>
                            <span className="cl-item"><span className="cl-swatch" style={{ background: 'var(--text-3)', borderTop: '2px dashed var(--text-3)', height: 0 }}></span>Normal</span>
                          </div>
                        </div>
                        <ClimateTrendChart series={climateTrendSeries} variable={V} year={climateYear} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="info-box-card">
                    <Info className="icon-info" />
                    <p>Click the map or use the District selector to see a district's actual vs. normal values and weekly trajectory.</p>
                  </div>
                )}
              </div>
            );
          })()}

          {analysisMode === "awd" && awdData && (
            <div className="insights-panel">
              <div className="sidebar-card">
                <div className="card-header">
                  <Sprout className="icon" />
                  <h2>AWD Plot Insights</h2>
                </div>
                <div className="card-body">
                  <div className="stats-grid">
                    <div className="stat-card">
                      <div className="stat-label">Total Paddy Area</div>
                      <div className="stat-val">{awdPlotInsights.totalArea.toFixed(1)}</div>
                      <div className="metric-unit">ha</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Avg Plot Size</div>
                      <div className="stat-val">{awdPlotInsights.avgArea.toFixed(2)}</div>
                      <div className="metric-unit">ha</div>
                    </div>
                  </div>
                  <div className="result-footer" style={{ marginTop: '10px' }}>
                    <span className="result-footer-meta">{awdPlotInsights.plotCount.toLocaleString()} plots monitored</span>
                    <span className="result-footer-meta">Primary: {climateTitleCase(awdPlotInsights.primaryMethod)}</span>
                  </div>
                </div>
              </div>

              {awdSelectedFid != null && awdSelectedProps ? (
                <div className="sidebar-card">
                  <div className="card-header">
                    <MapPin className="icon" />
                    <h2>Plot #{awdSelectedProps.FID}</h2>
                  </div>
                  <div className="card-body">
                    <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                      <div className="metrics-list">
                        {AWD_METRIC_ORDER.map(k => {
                          const vDef = awdData.varByKey[k];
                          if (!vDef) return null;
                          let val = awdSelectedProps[k];
                          if (vDef.type === 'num' && val != null) {
                            if (k === 'parea') val = val.toFixed(2) + ' ha';
                            else if (k === 'avgdepth' || k === 'depthvar') val = val.toFixed(2) + ' cm';
                            else if (k === 'swater') val = Number(val.toFixed(0)).toLocaleString('en-IN') + ' m²';
                            else if (AWD_DAY_KEYS.has(k)) val = val + ' d';
                            else val = Number(val).toFixed(1);
                          } else if (vDef.type === 'cat' && val != null) {
                            val = climateTitleCase(val);
                          }
                          if (val == null) val = '—';
                          const isActive = k === awdColorByKey;
                          return (
                            <React.Fragment key={k}>
                              <div className={`k ${isActive ? 'is-active-var' : ''}`}>{vDef.label}</div>
                              <div className={`v ${isActive ? 'is-active-var' : ''}`}>{val}</div>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    </div>
                    <div className="chart-block">
                      <div className="chart-head">
                        <h3>Relative water depth</h3>
                        <span className="chart-year">cm</span>
                      </div>
                      <AwdDepthChart dates={awdData.dates} depthCm={awdSelectedDepthCm} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="info-box-card">
                  <Info className="icon-info" />
                  <p>Click a plot on the map, or search/select a Plot ID, to see its metrics and water-depth history.</p>
                </div>
              )}
            </div>
          )}

          {/* FLOATING SIDEBAR RIGHT - RESULTS OVERLAY */}
          {((spectralResult && analysisMode === "single") ||
            (timeSeriesResult && analysisMode === "timeseries") ||
            (lulcResult && analysisMode === "lulc") ||
            (aefResult && analysisMode === "aef") ||
            (similarityResult && analysisMode === "similarity") ||
            (floodResult && analysisMode === "flood") ||
            (etSingleResult && analysisMode === "et") ||
            (etSeriesResult && analysisMode === "et_timeseries")) && (
            <>
            <button 
              className={`results-toggle-btn ${!resultsPanelOpen ? 'collapsed' : ''}`}
              onClick={() => setResultsPanelOpen(prev => !prev)}
              title={resultsPanelOpen ? "Hide Results Panel" : "Show Results Panel"}
              style={{ right: resultsPanelOpen ? resultsWidth : 0 }}
            >
              {resultsPanelOpen ? '›' : '‹'}
            </button>
            <div 
              className={`results-overlay ${!resultsPanelOpen ? 'collapsed' : ''}`}
              style={{ width: resultsWidth }}
            >
              {/* Resize Handle Drag Bar */}
              <div 
                className="resize-handle" 
                onMouseDown={startResize} 
                title="Drag to resize panel width"
              />

              {/* TAB 1: SPECTRAL MONITOR RESULTS */}
              {spectralResult && analysisMode === "single" && (
                <>
                  <div className="results-header">
                    <span>📈 {spectralIndex} ANALYTICS</span>
                    <Activity size={14} className="text-cyan-400" />
                  </div>

                  <div className="result-section">
                    <div className="stats-grid">
                      <div className="stat-card">
                        <div className="stat-label">Mean</div>
                        <div className="stat-val high">{(spectralResult.stats?.mean ?? 0).toFixed(3)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Std Dev</div>
                        <div className="stat-val">{(spectralResult.stats?.std ?? 0).toFixed(3)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Min</div>
                        <div className="stat-val danger">{(spectralResult.stats?.min ?? 0).toFixed(3)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Max</div>
                        <div className="stat-val success">{(spectralResult.stats?.max ?? 0).toFixed(3)}</div>
                      </div>
                    </div>

                    <div className="mt-3 pt-3 border-t flex flex-col gap-2">
                      <button
                        onClick={() => renderRasterOverlay(spectralResult.image_url, [minLon, minLat, maxLon, maxLat])}
                        className="radio-button py-2 text-xs justify-center items-center flex gap-1 border-dashed w-full"
                      >
                        <Eye size={14} /> View Image Overlay
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* TIME SERIES RESULTS */}
              {timeSeriesResult && analysisMode === "timeseries" && (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  <div className="results-header">
                    <span>📈 SEASONAL {spectralIndex} TREND</span>
                    <Activity size={14} className="text-cyan-400" />
                  </div>
                  
                  <TimeSeriesChart 
                    data={timeSeriesResult.timeseries} 
                    indexName={spectralIndex} 
                    onViewScene={loadSpecificSceneRaster}
                    activeSceneId={selectedSceneId}
                  />
                </div>
              )}

              {/* LULC MAPPING RESULTS */}
              {lulcResult && analysisMode === "lulc" && (() => {
                const statsEntries = Object.entries(lulcResult.stats || {}).sort((a, b) => b[1].percentage - a[1].percentage);
                const totalArea = statsEntries.reduce((sum, [, v]) => sum + (v.area_ha || 0), 0);

                // Donut chart calculations
                const donutSize = 160;
                const donutR = 58;
                const donutInnerR = 36;
                const donutCx = donutSize / 2;
                const donutCy = donutSize / 2;
                let donutAngle = -90; // start from top

                const donutSegments = statsEntries.map(([classVal, info]) => {
                  const angleDeg = (info.percentage / 100) * 360;
                  const startAngle = donutAngle;
                  donutAngle += angleDeg;
                  const endAngle = donutAngle;

                  const startRad = (startAngle * Math.PI) / 180;
                  const endRad = (endAngle * Math.PI) / 180;

                  const x1 = donutCx + donutR * Math.cos(startRad);
                  const y1 = donutCy + donutR * Math.sin(startRad);
                  const x2 = donutCx + donutR * Math.cos(endRad);
                  const y2 = donutCy + donutR * Math.sin(endRad);

                  const ix1 = donutCx + donutInnerR * Math.cos(endRad);
                  const iy1 = donutCy + donutInnerR * Math.sin(endRad);
                  const ix2 = donutCx + donutInnerR * Math.cos(startRad);
                  const iy2 = donutCy + donutInnerR * Math.sin(startRad);

                  const largeArc = angleDeg > 180 ? 1 : 0;

                  const pathD = [
                    `M ${x1} ${y1}`,
                    `A ${donutR} ${donutR} 0 ${largeArc} 1 ${x2} ${y2}`,
                    `L ${ix1} ${iy1}`,
                    `A ${donutInnerR} ${donutInnerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
                    'Z'
                  ].join(' ');

                  return { classVal, info, pathD };
                });

                // CSV Export for LULC
                const handleLulcCsvExport = () => {
                  let csvContent = "data:text/csv;charset=utf-8,";
                  csvContent += "Class,Pixels,Area_Ha,Percentage\n";
                  statsEntries.forEach(([, info]) => {
                    csvContent += `${info.name},${info.pixel_count},${info.area_ha},${info.percentage}\n`;
                  });
                  const encodedUri = encodeURI(csvContent);
                  const link = document.createElement("a");
                  link.setAttribute("href", encodedUri);
                  link.setAttribute("download", `LULC_${lulcResult.dataset}_${lulcResult.year}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <>
                  <div className="results-header">
                    <span>🗺️ LULC CLASSIFICATION — {lulcResult.year}</span>
                    <MapPin size={14} className="text-cyan-400" />
                  </div>

                  <div className="result-section-meta">
                    <span className="accent">ML Based LULC</span>
                    <span className="sep">•</span>
                    <span>{statsEntries.length} classes detected</span>
                    <span className="sep">•</span>
                    <span>{totalArea.toFixed(1)} ha total</span>
                  </div>

                  {/* Categorical Legend */}
                  <div className="result-section">
                    <div className="lulc-section-title">Land Cover Classes</div>
                    <div className="lulc-legend-grid">
                      {statsEntries.map(([classVal, info]) => (
                        <div key={classVal} className="lulc-legend-item">
                          <span className="lulc-color-swatch" style={{ backgroundColor: info.color }}></span>
                          <span className="lulc-legend-name">{info.name}</span>
                          <span className="lulc-legend-pct">{info.percentage.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Coverage: stacked bar + donut together */}
                  <div className="result-section">
                    <div className="lulc-section-title">Coverage Distribution</div>
                    <div className="lulc-bar-chart">
                      {statsEntries.map(([classVal, info]) => (
                        <div
                          key={classVal}
                          className="lulc-bar-segment"
                          style={{
                            width: `${Math.max(info.percentage, 0.5)}%`,
                            backgroundColor: info.color
                          }}
                          title={`${info.name}: ${info.percentage.toFixed(1)}%`}
                        ></div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <svg width={donutSize} height={donutSize} viewBox={`0 0 ${donutSize} ${donutSize}`}>
                        {donutSegments.map((seg, idx) => (
                          <path
                            key={idx}
                            d={seg.pathD}
                            fill={seg.info.color}
                            stroke="var(--bg-card)"
                            strokeWidth="1"
                            style={{ cursor: 'pointer' }}
                          >
                            <title>{seg.info.name}: {seg.info.percentage.toFixed(1)}%</title>
                          </path>
                        ))}
                        {/* Center label */}
                        <text x={donutCx} y={donutCy - 4} textAnchor="middle" fill="var(--text-main)" fontSize="11" fontWeight="700">
                          {statsEntries.length}
                        </text>
                        <text x={donutCx} y={donutCy + 10} textAnchor="middle" fill="var(--text-muted)" fontSize="8">
                          Classes
                        </text>
                      </svg>
                    </div>
                  </div>

                  {/* Statistics Table */}
                  <div className="result-section">
                    <div className="lulc-section-title">Area Statistics</div>
                    <div className="lulc-stats-table-wrap">
                      <table className="lulc-stats-table">
                        <thead>
                          <tr>
                            <th></th>
                            <th>Class</th>
                            <th>Pixels</th>
                            <th>Area (ha)</th>
                            <th>%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statsEntries.map(([classVal, info]) => (
                            <tr key={classVal}>
                              <td><span className="lulc-color-swatch-sm" style={{ backgroundColor: info.color }}></span></td>
                              <td className="font-bold" style={{ color: info.color }}>{info.name}</td>
                              <td>{info.pixel_count.toLocaleString()}</td>
                              <td>{info.area_ha.toFixed(1)}</td>
                              <td style={{ fontWeight: 'bold' }}>{info.percentage.toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="result-footer">
                      <span className="result-footer-meta">Total: {totalArea.toFixed(1)} ha</span>
                      <button onClick={handleLulcCsvExport} className="excel-btn">
                        Export CSV
                      </button>
                    </div>
                  </div>
                </>
                );
              })()}

              {/* AI CLUSTERING RESULTS */}
              {aefResult && analysisMode === "aef" && (() => {
                const statsEntries = Object.entries(aefResult.stats || {}).sort((a, b) => b[1].percentage - a[1].percentage);
                const totalArea = statsEntries.reduce((sum, [, v]) => sum + (v.area_ha || 0), 0);

                // Donut chart calculations
                const donutSize = 160;
                const donutR = 58;
                const donutInnerR = 36;
                const donutCx = donutSize / 2;
                const donutCy = donutSize / 2;
                let donutAngle = -90;

                const donutSegments = statsEntries.map(([classVal, info]) => {
                  const angleDeg = (info.percentage / 100) * 360;
                  const startAngle = donutAngle;
                  donutAngle += angleDeg;
                  const endAngle = donutAngle;

                  const startRad = (startAngle * Math.PI) / 180;
                  const endRad = (endAngle * Math.PI) / 180;

                  const x1 = donutCx + donutR * Math.cos(startRad);
                  const y1 = donutCy + donutR * Math.sin(startRad);
                  const x2 = donutCx + donutR * Math.cos(endRad);
                  const y2 = donutCy + donutR * Math.sin(endRad);

                  const ix1 = donutCx + donutInnerR * Math.cos(endRad);
                  const iy1 = donutCy + donutInnerR * Math.sin(endRad);
                  const ix2 = donutCx + donutInnerR * Math.cos(startRad);
                  const iy2 = donutCy + donutInnerR * Math.sin(startRad);

                  const largeArc = angleDeg > 180 ? 1 : 0;

                  const pathD = [
                    `M ${x1} ${y1}`,
                    `A ${donutR} ${donutR} 0 ${largeArc} 1 ${x2} ${y2}`,
                    `L ${ix1} ${iy1}`,
                    `A ${donutInnerR} ${donutInnerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
                    'Z'
                  ].join(' ');

                  return { classVal, info, pathD };
                });

                // CSV Export for AEF Cluster
                const handleAefCsvExport = () => {
                  let csvContent = "data:text/csv;charset=utf-8,";
                  csvContent += "Cluster,Custom Label,Pixels,Area_Ha,Percentage\n";
                  statsEntries.forEach(([classVal, info]) => {
                    const customLabel = customClusterNames[classVal] || info.name;
                    csvContent += `"${info.name}","${customLabel.replace(/"/g, '""')}",${info.pixel_count},${info.area_ha},${info.percentage}\n`;
                  });
                  const encodedUri = encodeURI(csvContent);
                  const link = document.createElement("a");
                  link.setAttribute("href", encodedUri);
                  link.setAttribute("download", `AEF_Clustering_${aefResult.year}_K${aefResult.num_clusters}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <>
                  <div className="results-header">
                    <span>🤖 AI CLUSTERING — {aefResult.year}</span>
                    <Cpu size={14} className="text-cyan-400" />
                  </div>

                  <div className="result-section-meta">
                    <span className="accent">AlphaEarth K-Means</span>
                    <span className="sep">•</span>
                    <span>{statsEntries.length} clusters</span>
                    <span className="sep">•</span>
                    <span>{totalArea.toFixed(1)} ha total</span>
                  </div>

                  {/* Interactive Legend with Rename Inputs */}
                  <div className="result-section">
                    <div className="lulc-section-title">Classify / Label Clusters</div>
                    <div className="flex flex-col gap-1.5">
                      {statsEntries.map(([classVal, info]) => {
                        const currentName = customClusterNames[classVal] || info.name;
                        return (
                          <div key={classVal} className="aef-cluster-row">
                            <span className="aef-color-swatch-circle" style={{ backgroundColor: info.color }}></span>
                            <input
                              type="text"
                              value={currentName}
                              onChange={e => setCustomClusterNames(prev => ({ ...prev, [classVal]: e.target.value }))}
                              className="aef-cluster-input"
                              placeholder={`Rename ${info.name}...`}
                            />
                            <span className="aef-cluster-pct">{info.percentage.toFixed(1)}%</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Coverage: stacked bar + donut together */}
                  <div className="result-section">
                    <div className="lulc-section-title">Coverage Distribution</div>
                    <div className="lulc-bar-chart">
                      {statsEntries.map(([classVal, info]) => {
                        const label = customClusterNames[classVal] || info.name;
                        return (
                          <div
                            key={classVal}
                            className="lulc-bar-segment"
                            style={{
                              width: `${Math.max(info.percentage, 0.5)}%`,
                              backgroundColor: info.color
                            }}
                            title={`${label}: ${info.percentage.toFixed(1)}%`}
                          ></div>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <svg width={donutSize} height={donutSize} viewBox={`0 0 ${donutSize} ${donutSize}`}>
                        {donutSegments.map((seg, idx) => {
                          const label = customClusterNames[seg.classVal] || seg.info.name;
                          return (
                            <path
                              key={idx}
                              d={seg.pathD}
                              fill={seg.info.color}
                              stroke="var(--bg-card)"
                              strokeWidth="1.5"
                              style={{ cursor: 'pointer' }}
                            >
                              <title>{label}: {seg.info.percentage.toFixed(1)}%</title>
                            </path>
                          );
                        })}
                        <text x={donutCx} y={donutCy - 4} textAnchor="middle" fill="var(--text-main)" fontSize="11" fontWeight="700">
                          {statsEntries.length}
                        </text>
                        <text x={donutCx} y={donutCy + 10} textAnchor="middle" fill="var(--text-muted)" fontSize="8">
                          Clusters
                        </text>
                      </svg>
                    </div>
                  </div>

                  {/* Statistics Table */}
                  <div className="result-section">
                    <div className="lulc-section-title">Area Statistics</div>
                    <div className="lulc-stats-table-wrap">
                      <table className="lulc-stats-table">
                        <thead>
                          <tr>
                            <th></th>
                            <th>Class</th>
                            <th>Pixels</th>
                            <th>Area (ha)</th>
                            <th>%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statsEntries.map(([classVal, info]) => {
                            const label = customClusterNames[classVal] || info.name;
                            return (
                              <tr key={classVal}>
                                <td><span className="lulc-color-swatch-sm" style={{ backgroundColor: info.color }}></span></td>
                                <td className="font-bold" style={{ color: info.color }}>{label}</td>
                                <td>{info.pixel_count.toLocaleString()}</td>
                                <td>{info.area_ha.toFixed(1)}</td>
                                <td style={{ fontWeight: 'bold' }}>{info.percentage.toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="result-footer">
                      <span className="result-footer-meta">Total: {totalArea.toFixed(1)} ha</span>
                      <button onClick={handleAefCsvExport} className="excel-btn">
                        Export CSV
                      </button>
                    </div>
                  </div>
                </>
                );
              })()}

              {/* AI SIMILARITY RESULTS */}
              {similarityResult && analysisMode === "similarity" && (() => {
                // Normalize every numeric field to a real number up front so a
                // missing/null field can never crash the panel via .toFixed().
                const raw = similarityResult.stats || {};
                const num = (v) => (typeof v === "number" && !isNaN(v) ? v : 0);
                const stats = {
                  ...raw,
                  threshold: num(raw.threshold),
                  match_pixels: num(raw.match_pixels),
                  match_area_ha: num(raw.match_area_ha),
                  match_percentage: num(raw.match_percentage),
                  min: num(raw.min), max: num(raw.max),
                  mean: num(raw.mean), std: num(raw.std),
                };
                const matchArea = stats.match_area_ha;
                const matchPct = stats.match_percentage;

                const handleSimilarityCsvExport = () => {
                  let csvContent = "data:text/csv;charset=utf-8,";
                  csvContent += "Metric,Value\n";
                  csvContent += `Threshold,${stats.threshold}\n`;
                  csvContent += `Matching Pixels,${stats.match_pixels}\n`;
                  csvContent += `Matching Area (ha),${stats.match_area_ha}\n`;
                  csvContent += `Matching Percentage (%),${stats.match_percentage}%\n`;
                  csvContent += `Min Similarity,${stats.min.toFixed(4)}\n`;
                  csvContent += `Max Similarity,${stats.max.toFixed(4)}\n`;
                  csvContent += `Mean Similarity,${stats.mean.toFixed(4)}\n`;
                  csvContent += `Std Dev Similarity,${stats.std.toFixed(4)}\n`;
                  
                  const encodedUri = encodeURI(csvContent);
                  const link = document.createElement("a");
                  link.setAttribute("href", encodedUri);
                  link.setAttribute("download", `AEF_Similarity_Search_${similarityResult.year}_T${stats.threshold}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <>
                  <div className="results-header">
                    <span>🤖 AI SIMILARITY ANALYSIS</span>
                    <Cpu size={14} className="text-cyan-400" />
                  </div>

                  <div className="result-section-meta">
                    <span className="accent">AlphaEarth Similarity</span>
                    <span className="sep">•</span>
                    <span>Year: {similarityResult.year}</span>
                    <span className="sep">•</span>
                    <span>Threshold: {stats.threshold.toFixed(3)}</span>
                  </div>

                  {/* Matching Statistics Card */}
                  <div className="aef-matching-card">
                    <span className="aef-matching-label">Matching Area Coverage</span>
                    <div className="aef-matching-value-row">
                      <span className="aef-matching-value">{matchArea.toLocaleString()} ha</span>
                      <span className="aef-matching-pct">({matchPct.toFixed(2)}% of ROI)</span>
                    </div>
                    <div className="aef-progress-track">
                      <div className="aef-progress-bar" style={{ width: `${matchPct}%` }}></div>
                    </div>
                  </div>

                  {/* Warning if no matching pixels */}
                  {stats.match_pixels === 0 && (
                    <div className="result-warning">
                      <AlertTriangle size={14} />
                      <span>
                        No features matched your query above threshold <strong>{stats.threshold.toFixed(3)}</strong>. Try lowering the threshold slider in the sidebar.
                      </span>
                    </div>
                  )}

                  {/* Cosine Similarity Statistics Grid */}
                  <div className="result-section">
                    <div className="lulc-section-title">Similarity Statistics</div>
                    <div className="stats-grid">
                      <div className="stat-card">
                        <div className="stat-label">Mean</div>
                        <div className="stat-val high">{stats.mean.toFixed(4)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Std Dev</div>
                        <div className="stat-val">{stats.std.toFixed(4)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Min</div>
                        <div className="stat-val danger">{stats.min.toFixed(4)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Max</div>
                        <div className="stat-val success">{stats.max.toFixed(4)}</div>
                      </div>
                    </div>
                    <div className="result-footer">
                      <span className="result-footer-meta">Match: {stats.match_pixels.toLocaleString()} px</span>
                      <button onClick={handleSimilarityCsvExport} className="excel-btn">
                        Export CSV
                      </button>
                    </div>
                  </div>
                </>
                );
              })()}

              {/* FLOOD DETECTION RESULTS */}
              {floodResult && analysisMode === "flood" && (() => {
                const raw = floodResult.stats || {};
                const num = (v) => (typeof v === "number" && !isNaN(v) ? v : 0);
                const areaKm2 = num(raw.area_km2);
                const pct = num(raw.percentage);
                const barPct = Math.min(100, pct);

                const handleFloodCsvExport = () => {
                  let csv = "data:text/csv;charset=utf-8,";
                  csv += "Metric,Value\n";
                  csv += `Orbit Pass,${floodResult.orbit}\n`;
                  csv += `Pre-Event Scene Date,${floodResult.pre_date}\n`;
                  csv += `Post-Event Scene Date,${floodResult.post_date}\n`;
                  csv += `Pre-Event Scene ID,${floodResult.pre_scene_id}\n`;
                  csv += `Post-Event Scene ID,${floodResult.post_scene_id}\n`;
                  csv += `Threshold (dB),${num(raw.threshold_db)}\n`;
                  csv += `Flooded Area (km2),${areaKm2}\n`;
                  csv += `Flooded ROI (%),${pct}\n`;
                  csv += `Flooded Pixels,${num(raw.flood_pixels)}\n`;
                  csv += `Before Median (dB),${num(raw.before_median_db)}\n`;
                  csv += `After Median (dB),${num(raw.after_median_db)}\n`;
                  csv += `Max Drop (dB),${num(raw.flood_max_db)}\n`;
                  const link = document.createElement("a");
                  link.setAttribute("href", encodeURI(csv));
                  link.setAttribute("download", `Flood_Detection_${floodResult.pre_date}_to_${floodResult.post_date}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                return (
                <>
                  <div className="results-header">
                    <span>🌊 FLOOD ANALYSIS</span>
                    <Droplets size={14} className="text-red-400" />
                  </div>

                  <div className="result-section-meta">
                    <span className="accent" style={{ color: 'var(--color-red)' }}>Sentinel-1 SAR</span>
                    <span className="sep">•</span>
                    <span style={{ textTransform: 'capitalize' }}>{floodResult.orbit}</span>
                    <span className="sep">•</span>
                    <span>Drop &gt; {num(raw.threshold_db).toFixed(1)} dB</span>
                  </div>

                  {/* Flooded area card */}
                  <div className="aef-matching-card">
                    <span className="aef-matching-label" style={{ color: 'var(--color-red)' }}>Estimated Flooded Area</span>
                    <div className="aef-matching-value-row">
                      <span className="aef-matching-value">{areaKm2.toLocaleString()} km²</span>
                      <span className="aef-matching-pct">({pct.toFixed(2)}% of ROI)</span>
                    </div>
                    <div className="aef-progress-track">
                      <div className="aef-progress-bar" style={{ width: `${barPct}%`, background: 'var(--color-red)' }}></div>
                    </div>
                  </div>

                  {/* Scene selection (closest-to-event images) */}
                  <div className="result-section">
                    <div className="lulc-section-title">Scenes Used (closest to event)</div>
                    <div className="flex flex-col gap-1.5" style={{ fontSize: '11.5px' }}>
                      <div className="flex items-center justify-between">
                        <span style={{ color: 'var(--text-muted)' }}>Pre-Event</span>
                        <span className="font-mono font-bold">{floodResult.pre_date}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span style={{ color: 'var(--text-muted)' }}>Post-Event</span>
                        <span className="font-mono font-bold">{floodResult.post_date}</span>
                      </div>
                      <div className="flex items-center justify-between pt-2 border-t" style={{ fontSize: '10px', color: 'var(--text-3)' }}>
                        <span>Candidates in windows</span>
                        <span>{floodResult.pre_count} pre · {floodResult.post_count} post</span>
                      </div>
                    </div>
                  </div>

                  {/* Warning if nothing flagged */}
                  {num(raw.flood_pixels) === 0 && (
                    <div className="result-warning">
                      <AlertTriangle size={14} />
                      <span>
                        No pixels exceeded the {num(raw.threshold_db).toFixed(1)} dB drop. Lower the threshold or check the date ranges / orbit pass.
                      </span>
                    </div>
                  )}

                  {/* Backscatter statistics */}
                  <div className="result-section">
                    <div className="lulc-section-title">Backscatter (VV, dB)</div>
                    <div className="stats-grid">
                      <div className="stat-card">
                        <div className="stat-label">Before Median</div>
                        <div className="stat-val">{num(raw.before_median_db).toFixed(2)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">After Median</div>
                        <div className="stat-val high">{num(raw.after_median_db).toFixed(2)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Max Drop</div>
                        <div className="stat-val success">{num(raw.flood_max_db).toFixed(2)}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Flood Pixels</div>
                        <div className="stat-val danger">{num(raw.flood_pixels).toLocaleString()}</div>
                      </div>
                    </div>
                  </div>

                  {/* Before / After preview thumbnails (live swipe is on the map) */}
                  <div className="result-section">
                    <div className="lulc-section-title">Before / After (VV backscatter)</div>
                    <div className="result-thumb-row">
                      <div className="result-thumb">
                        <img src={`${API_BASE}${floodResult.before_url}`} alt="Pre-event VV" />
                        <span className="result-thumb-caption">Before · {floodResult.pre_date}</span>
                      </div>
                      <div className="result-thumb">
                        <img src={`${API_BASE}${floodResult.after_url}`} alt="Post-event VV" />
                        <span className="result-thumb-caption">After · {floodResult.post_date}</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2" style={{ fontSize: '10.5px', color: 'var(--text-muted)', paddingTop: '2px' }}>
                      <span style={{ lineHeight: 1.5 }}>
                        Drag the vertical divider on the map — <strong style={{ color: 'var(--text-main)' }}>left = post-event</strong>, <strong style={{ color: 'var(--text-main)' }}>right = pre-event</strong>.
                      </span>
                      <label className="flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-main)' }}>
                        <input type="checkbox" checked={floodShowMask} onChange={e => setFloodShowMask(e.target.checked)} className="excel-checkbox" />
                        <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: 'rgba(224,62,62,0.85)' }}></span>
                        Overlay flood extent (red)
                      </label>
                    </div>
                  </div>

                  {/* dB-drop heatmap preview */}
                  <div className="result-section">
                    <div className="lulc-section-title">Backscatter Drop (dB)</div>
                    <img
                      src={`${API_BASE}${floodResult.diff_url}`}
                      alt="VV backscatter drop"
                      style={{ width: '100%', display: 'block', borderRadius: '4px', background: '#0a0f1e', border: '1px solid var(--border-color)' }}
                    />
                    <div className="result-footer">
                      <span className="result-footer-meta">Valid: {num(raw.valid_pixels).toLocaleString()} px</span>
                      <button onClick={handleFloodCsvExport} className="excel-btn">
                        Export CSV
                      </button>
                    </div>
                  </div>
                </>
                );
              })()}

              {/* EVAPOTRANSPIRATION (SEBAL) — SINGLE-DATE RESULTS */}
              {etSingleResult && analysisMode === "et" && (() => {
                const s = etSingleResult.stats || {};
                const bins = etSingleResult.density_bins || {};
                const met = etSingleResult.met || {};
                const anc = etSingleResult.anchors || {};
                const num = (v) => (typeof v === "number" && !isNaN(v) ? v : 0);

                const handleEtCsvExport = () => {
                  let csv = "data:text/csv;charset=utf-8,";
                  csv += "Metric,Value\n";
                  csv += `Scene ID,${etSingleResult.scene_id}\n`;
                  csv += `Date,${etSingleResult.date}\n`;
                  csv += `Cloud Cover (%),${etSingleResult.cloud_cover ?? ""}\n`;
                  csv += `Overpass Hour (UTC),${etSingleResult.overpass_hour_utc ?? ""}\n`;
                  csv += `Mean ETa (mm/day),${num(s.mean).toFixed(3)}\n`;
                  csv += `Std ETa (mm/day),${num(s.std).toFixed(3)}\n`;
                  csv += `Min ETa (mm/day),${num(s.min).toFixed(3)}\n`;
                  csv += `Max ETa (mm/day),${num(s.max).toFixed(3)}\n`;
                  csv += `Valid Pixels,${num(s.valid_pixels)}\n`;
                  csv += `Valid Area (km2),${num(s.valid_area_km2)}\n`;
                  csv += `Water Volume (m3/day),${num(s.water_volume_m3_day)}\n`;
                  csv += `Cold Anchor T (C),${num(anc.T_cold_C)}\n`;
                  csv += `Hot Anchor T (C),${num(anc.T_hot_C)}\n`;
                  csv += `Stability Iterations,${num(anc.iterations)}\n`;
                  csv += `Air Temp (C),${num(met.T_air_C)}\n`;
                  csv += `Relative Humidity (%),${num(met.RH_pct)}\n`;
                  csv += `Wind Speed (m/s),${num(met.wind_speed)}\n`;
                  csv += `Rs down (W/m2),${num(met.Rs_down)}\n`;
                  csv += `FAO-56 ET0 (mm/day),${etSingleResult.et0 ?? ""}\n`;
                  csv += `Crop Coefficient Kc,${etSingleResult.kc ?? ""}\n`;
                  const link = document.createElement("a");
                  link.setAttribute("href", encodeURI(csv));
                  link.setAttribute("download", `SEBAL_ET_${etSingleResult.date}.csv`);
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                };

                // ET-intensity label + position on a 0–8 mm/day gauge.
                const meanEt = num(s.mean);
                const etLevel = meanEt > 6 ? { label: 'Very high water use', color: '#3b82f6' }
                  : meanEt >= 4 ? { label: 'High water use', color: '#22c55e' }
                  : meanEt >= 2 ? { label: 'Moderate water use', color: '#f59e0b' }
                  : { label: 'Low water use', color: '#ef4444' };
                const gaugeMin = etSingleResult.vis_min != null ? Number(etSingleResult.vis_min) : 0;
                const gaugeMax = etSingleResult.vis_max != null ? Number(etSingleResult.vis_max) : 8;
                const gaugePct = gaugeMax > gaugeMin 
                  ? Math.max(0, Math.min(100, ((meanEt - gaugeMin) / (gaugeMax - gaugeMin)) * 100))
                  : 50;
                // Crop coefficient interpretation.
                const kcVal = etSingleResult.kc;
                const kcInfo = kcVal == null ? null
                  : kcVal >= 1.0 ? { label: 'very high water use', color: '#3b82f6' }
                  : kcVal >= 0.7 ? { label: 'well-watered', color: '#22c55e' }
                  : kcVal >= 0.4 ? { label: 'moderate', color: '#f59e0b' }
                  : { label: 'low / water-stressed', color: '#ef4444' };
                const distClasses = [
                  { key: 'very_high', label: 'Very high >6', color: '#1e3a8a' },
                  { key: 'high', label: 'High 4–6', color: '#16a34a' },
                  { key: 'moderate', label: 'Moderate 2–4', color: '#f59e0b' },
                  { key: 'low', label: 'Low <2', color: '#dc2626' },
                ];

                return (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  {/* 1. Header */}
                  <div className="flex items-center justify-between border-b border-slate-700/50 pb-3 mb-1">
                    <div className="flex items-center gap-2">
                      <Droplets size={20} className="text-cyan-400 fill-cyan-400/20" />
                      <span className="text-sm font-bold tracking-wider text-white">EVAPOTRANSPIRATION (SEBAL)</span>
                    </div>
                    <Droplets size={16} className="text-cyan-400/50" />
                  </div>

                  {/* 2. Subheader */}
                  <div className="text-[11px] text-slate-400 flex items-center gap-3 mb-2">
                    <div className="flex items-center gap-1.5"><Satellite size={12} className="text-cyan-400" /><span className="text-cyan-400 font-bold uppercase">LANDSAT-9</span></div>
                    <span className="text-slate-600">|</span>
                    <div className="flex items-center gap-1.5"><Calendar size={12} /><span>{new Date(etSingleResult.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
                    {etSingleResult.cloud_cover != null && (
                      <>
                        <span className="text-slate-600">|</span>
                        <div className="flex items-center gap-1.5"><Cloud size={12} /><span>{num(etSingleResult.cloud_cover).toFixed(0)}% cloud</span></div>
                      </>
                    )}
                  </div>

                  {/* 3. Mean Actual ET */}
                  <div className="p-4 rounded-xl flex flex-col gap-3 border border-slate-700/50 bg-slate-900/40">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">Mean Actual ET</span>
                      <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded" style={{ color: etLevel.color, background: etLevel.color + '22' }}>{etLevel.label}</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-5xl font-bold text-white leading-none">{meanEt.toFixed(2)}</span>
                      <span className="text-sm text-slate-400">mm/day</span>
                    </div>
                    
                    <div className="flex flex-col gap-1 mt-2">
                      <div className="flex justify-between text-[10px] text-white">
                        <span>Low</span><span>High</span>
                      </div>
                      <div className="relative w-full rounded-full" style={{ height: '6px', background: `linear-gradient(90deg, ${get_color_palette(etPalette).join(', ')})` }}>
                        <div className="absolute rounded-full border-2 border-white bg-slate-200"
                             style={{ left: `calc(${gaugePct}% - 6px)`, top: '-3px', width: '12px', height: '12px', boxShadow: '0 0 4px rgba(0,0,0,0.6)' }} />
                      </div>
                      <div className="flex justify-between text-[11px] text-slate-300 font-mono mt-1 relative">
                        <span>{gaugeMin.toFixed(2)}</span>
                        <div className="flex flex-col items-center absolute" style={{ left: `calc(${gaugePct}%)`, transform: 'translateX(-50%)', top: '10px' }}>
                          <span className="font-bold text-[12px]" style={{ color: '#22c55e' }}>{meanEt.toFixed(2)}</span>
                          <span className="text-[9px] text-slate-400 font-sans whitespace-nowrap">Current ET</span>
                        </div>
                        <span>{gaugeMax.toFixed(2)}</span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-8 pt-3 border-t border-slate-700/50">
                      <Droplets size={12} className="text-cyan-400" />
                      ≈ <span className="text-white font-semibold">{num(s.water_volume_m3_day).toLocaleString()}</span> m³/day over {num(s.valid_area_km2).toLocaleString()} km²
                    </div>
                  </div>

                  {/* 4. Stats Grid 2x2 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-900/40 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full border border-blue-500/30 flex items-center justify-center bg-blue-500/10 text-blue-400 shrink-0">
                        <LineChart size={18} />
                      </div>
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-[9px] font-bold text-slate-400 tracking-wider truncate">AVERAGE</span>
                        <span className="text-xl font-bold text-white leading-tight">{num(s.mean).toFixed(2)}</span>
                        <span className="text-[10px] text-slate-500">mm/day</span>
                      </div>
                    </div>
                    <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-900/40 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full border border-blue-400/30 flex items-center justify-center bg-blue-400/10 text-blue-300 shrink-0">
                        <Activity size={18} />
                      </div>
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-[9px] font-bold text-slate-400 tracking-wider truncate">STD. DEVIATION</span>
                        <span className="text-xl font-bold text-white leading-tight">{num(s.std).toFixed(2)}</span>
                        <span className="text-[10px] text-slate-500">mm/day</span>
                      </div>
                    </div>
                    <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-900/40 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full border border-red-500/30 flex items-center justify-center bg-red-500/10 text-red-400 shrink-0">
                        <ArrowDown size={18} />
                      </div>
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-[9px] font-bold text-slate-400 tracking-wider truncate">MINIMUM</span>
                        <span className="text-xl font-bold text-red-400 leading-tight">{num(s.min).toFixed(2)}</span>
                        <span className="text-[10px] text-slate-500">mm/day</span>
                      </div>
                    </div>
                    <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-900/40 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full border border-green-500/30 flex items-center justify-center bg-green-500/10 text-green-400 shrink-0">
                        <ArrowUp size={18} />
                      </div>
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-[9px] font-bold text-slate-400 tracking-wider truncate">MAXIMUM</span>
                        <span className="text-xl font-bold text-green-400 leading-tight">{num(s.max).toFixed(2)}</span>
                        <span className="text-[10px] text-slate-500">mm/day</span>
                      </div>
                    </div>
                  </div>

                  {/* 5. Reference ET */}
                  {etSingleResult.et0 != null && (
                    <div className="flex flex-col gap-2 mt-1">
                      <span className="text-[11px] font-bold text-cyan-400 tracking-wider">REFERENCE ET (FAO-56)</span>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-900/40 flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full border border-blue-400/30 flex items-center justify-center bg-blue-400/10 text-blue-400 shrink-0">
                            <Droplets size={18} className="fill-blue-400/20" />
                          </div>
                          <div className="flex flex-col overflow-hidden">
                            <span className="text-[9px] font-bold text-slate-400 tracking-wider truncate">ETo (MM/DAY)</span>
                            <span className="text-xl font-bold text-white leading-tight">{num(etSingleResult.et0).toFixed(2)}</span>
                            <span className="text-[10px] text-slate-500">mm/day</span>
                          </div>
                        </div>
                        <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-900/40 flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full border border-green-500/30 flex items-center justify-center bg-green-500/10 text-green-400 shrink-0">
                            <Leaf size={18} />
                          </div>
                          <div className="flex flex-col overflow-hidden">
                            <span className="text-[9px] font-bold text-slate-400 tracking-wider truncate">CROP COEFFICIENT (Kc)</span>
                            <span className="text-xl font-bold text-white leading-tight">{kcVal != null ? num(kcVal).toFixed(2) : "—"}</span>
                          </div>
                        </div>
                      </div>
                      {kcInfo && (
                        <div className="flex items-start gap-2 text-[11px] text-slate-400 mt-1 px-1">
                          <Info size={14} className="flex-shrink-0 text-cyan-500 mt-0.5" />
                          <span>
                            Crop coefficient (Kc = {num(kcVal).toFixed(2)}) indicates <span style={{ color: kcInfo.color }}>{kcInfo.label}</span> crop water use relative to the FAO-56 reference surface.
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 6. Distribution */}
                  {etSingleResult.density_bins && (
                    <div className="flex flex-col gap-2 mt-2">
                      <span className="text-[11px] font-bold text-cyan-400 tracking-wider">ET DISTRIBUTION (MM/DAY)</span>
                      <div className="flex w-full rounded-md overflow-hidden bg-slate-800" style={{ height: '16px' }}>
                        {distClasses.map(c => num(bins[c.key]) > 0 && (
                          <div key={c.key} className="flex items-center justify-center text-[9px] font-bold text-black/60" style={{ width: `${num(bins[c.key])}%`, background: c.color }} title={`${c.label}: ${num(bins[c.key])}%`}>
                            {num(bins[c.key]) > 10 ? `${num(bins[c.key])}%` : ''}
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-4 gap-x-1 gap-y-1 mt-1">
                        {distClasses.map(c => (
                          <div key={c.key} className="flex flex-col items-center text-[9px]">
                            <div className="flex items-center gap-1">
                              <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color, display: 'inline-block', flexShrink: 0 }} />
                              <span className="text-slate-300 truncate text-center">{c.label}</span>
                            </div>
                            <span className="text-slate-500 font-mono mt-0.5">{num(bins[c.key])}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 7. Statistics Export */}
                  <div className="flex items-center justify-between p-3 rounded-xl bg-slate-800/50 border border-slate-700/50 mt-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-slate-700/50 flex items-center justify-center text-slate-300 shrink-0">
                        <Layers size={18} />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[11px] font-bold text-white tracking-wider">STATISTICS EXPORT</span>
                        <span className="text-[10px] text-slate-400 leading-tight mt-0.5">Export SEBAL statistics and<br/>inputs as CSV. (GeoTIFF raster download is in the footer below.)</span>
                      </div>
                    </div>
                    <button onClick={handleEtCsvExport} className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold text-[10px] uppercase tracking-wider transition-colors shrink-0">
                      <Download size={14} /> DOWNLOAD CSV
                    </button>
                  </div>
                </div>
                );
              })()}

              {/* EVAPOTRANSPIRATION (SEBAL) — SEASONAL TREND RESULTS */}
              {etSeriesResult && analysisMode === "et_timeseries" && (
                <div className="glass-panel p-4 flex flex-col gap-3" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                  <div className="results-header">
                    <span>💧 SEASONAL ET TREND (SEBAL)</span>
                    <Droplets size={14} className="text-cyan-400" />
                  </div>

                  <TimeSeriesChart
                    data={etSeriesResult.timeseries}
                    indexName="ETa (mm/day)"
                    onViewScene={loadSpecificEtScene}
                    activeSceneId={selectedSceneId}
                  />

                  {etSeriesResult.skipped && etSeriesResult.skipped.length > 0 && (
                    <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded flex items-start gap-2 text-amber-400">
                      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                      <span className="text-[10px] leading-normal">
                        {etSeriesResult.skipped.length} scene(s) skipped (anchor/CDS failure). SEBAL needs clear scenes with both vegetated and bare ground.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
            </>
          )}
        </section>
      </div>

      {/* TELEMETRY FOOTER */}
      <footer className="footer">
        <div className="footer-feature-item">
          <div className="feat-icon-wrapper">
            <Satellite className="footer-icon" />
          </div>
          <div>
            <h3>SENSOR PLATFORM</h3>
            <p>
              {analysisMode === "aef" ? "AlphaEarth Foundations" :
               analysisMode === "similarity" ? "AlphaEarth Foundations" :
               analysisMode === "lulc" ? "ML Based LULC" :
               analysisMode === "flood" ? "Sentinel-1 GRD (SAR)" :
               (analysisMode === "et" || analysisMode === "et_timeseries") ? "Landsat-9 C2-L2 + ERA5-Land (SEBAL)" :
               analysisMode === "lsm" ? "Landslide Susceptibility Model (ILSM)" :
               analysisMode === "deformation" ? "InSAR Sentinel-1 (LOS Velocities)" :
               analysisMode === "climate" ? "IMD Gridded Rainfall & Temperature (Weekly)" :
               analysisMode === "awd" ? "SwanSat AWD Plot Monitoring" :
               selectedSceneMeta ? selectedSceneMeta.sensor : "NO ACTIVE SENSOR"}
            </p>
          </div>
        </div>

        <div className="footer-feature-item">
          <div className="feat-icon-wrapper">
            <Clock className="footer-icon" />
          </div>
          <div>
            <h3>ACQUISITION DATE</h3>
            <p>
              {analysisMode === "aef" ? `${aefYear} (Annual Composite)` :
               analysisMode === "similarity" ? `${aefYear} (Annual Composite)` :
               analysisMode === "lulc" ? `${lulcYear} (Annual Classification)` :
               analysisMode === "flood" ? (floodResult ? `${floodResult.pre_date} → ${floodResult.post_date}` : "Pre / Post date ranges") :
               analysisMode === "et" ? (etSingleResult ? etSingleResult.date : "Select a Landsat-9 scene") :
               analysisMode === "et_timeseries" ? `${startDate} → ${endDate}` :
               analysisMode === "lsm" ? "ILSM v1.0 (Static Overlays)" :
               analysisMode === "deformation" ? "Sentinel-1 Composite (2021-2024)" :
               analysisMode === "climate" ? (climateWeekData ? `${climateFmtDate(climateWeekData.start)} → ${climateFmtDate(climateWeekData.end)}` : "Select a week") :
               analysisMode === "awd" ? (awdData ? `${awdData.dates[0]} → ${awdData.dates[awdData.dates.length - 1]}` : "Loading…") :
               selectedSceneMeta ? selectedSceneMeta.date : "IDLE / PENDING"}
            </p>
          </div>
        </div>

        <div className="footer-feature-item" style={{ overflow: 'visible' }}>
          <div className="feat-icon-wrapper">
            <Layers className="footer-icon" />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'visible' }}>
            <h3>MAP LEGEND</h3>
              {spectralResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>{spectralIndex} Scale</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: getPaletteGradientString() }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>{visMin}</span>
                    <span>{((parseFloat(visMin) + parseFloat(visMax)) / 2).toFixed(1)}</span>
                    <span>{visMax}</span>
                  </div>
                </div>
              )}
              {analysisMode === "similarity" && similarityResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>Cosine Similarity Scale</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: getPaletteGradientString() }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>{similarityResult.vis_min.toFixed(2)}</span>
                    <span>{((similarityResult.vis_min + similarityResult.vis_max) / 2).toFixed(2)}</span>
                    <span>{similarityResult.vis_max.toFixed(2)}</span>
                  </div>
                </div>
              )}
              {analysisMode === "flood" && floodResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: 'rgba(239, 68, 68, 0.85)' }}></span>
                    <span>Candidate Flood (VV drop &gt; {(floodResult.stats?.threshold_db ?? 3).toFixed(1)} dB)</span>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    {(floodResult.stats?.area_km2 ?? 0).toLocaleString()} km² · {(floodResult.stats?.percentage ?? 0).toFixed(2)}% of ROI
                  </div>
                </div>
              )}
              {analysisMode === "et" && etSingleResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>Actual ET (mm/day) · dry → wet</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: `linear-gradient(90deg, ${get_color_palette(etPalette).join(', ')})` }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>{Number(etSingleResult.vis_min).toFixed(1)}</span>
                    <span>{((Number(etSingleResult.vis_min) + Number(etSingleResult.vis_max)) / 2).toFixed(1)}</span>
                    <span>{Number(etSingleResult.vis_max).toFixed(1)}</span>
                  </div>
                </div>
              )}
              {analysisMode === "et_timeseries" && etSeriesResult && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>Seasonal ET trend — see chart</span>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    {etSeriesResult.timeseries?.length || 0} scene(s) · mean ETa (mm/day)
                  </div>
                </div>
              )}
              {analysisMode === "lsm" && activeLsmOverlay === "probability" && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>Probability Heatmap (Turbo)</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: 'linear-gradient(90deg, #30123b, #466be3, #28bbec, #32f197, #a2fc3c, #f2f221, #fc8961, #cf2547, #7a0403)' }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>Very Low (0.0)</span>
                    <span>High (1.0)</span>
                  </div>
                </div>
              )}
              {analysisMode === "lsm" && activeLsmOverlay === "classes" && (
                <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                    <span>Susceptibility Classes (Viridis)</span>
                  </div>
                  <div style={{ height: '8px', width: '100%', borderRadius: '2px', background: 'linear-gradient(90deg, #440154, #3b528b, #21918c, #5ec962, #fde725)' }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                    <span>Class 1 (Very Low)</span>
                    <span>Class 5 (Very High)</span>
                  </div>
                </div>
              )}
              {analysisMode === "deformation" && defManifest && (
                <div style={{ display: 'flex', flexDirection: 'row', width: '100%', gap: '8px', overflow: 'visible' }}>
                  {defVisibleLayers.has('asc') && (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '2px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                        <span>Ascending LOS (mm/yr)</span>
                      </div>
                      <div style={{ height: '6px', width: '100%', borderRadius: '2px', background: 'linear-gradient(90deg, #053061, #2166ac, #4393c3, #92c5de, #d1e5f0, #f7f7f7, #fddbc7, #f4a582, #d6604d, #b2182b, #67001f)' }}></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                        <span>-21.0</span>
                        <span>0</span>
                        <span>21.0</span>
                      </div>
                    </div>
                  )}
                  {defVisibleLayers.has('dsc') && (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '2px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>
                        <span>Descending LOS (mm/yr)</span>
                      </div>
                      <div style={{ height: '6px', width: '100%', borderRadius: '2px', background: 'linear-gradient(90deg, #276419, #4d9221, #7fbc41, #b8e186, #e6f5d0, #f7f7f7, #fde0ef, #f1b2dc, #de77ae, #c51b7d, #8e0152)' }}></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                        <span>-21.0</span>
                        <span>0</span>
                        <span>21.0</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {analysisMode === "climate" && (
                <div className="footer-swatch-row">
                  {CLIMATE_VARIABLES[climateVar].categories.filter(c => c.key !== "No Data").map(c => (
                    <span key={c.key} className="footer-swatch-item">
                      <span className="footer-swatch-dot" style={{ background: c.color }}></span>
                      {c.key}
                    </span>
                  ))}
                </div>
              )}
              {analysisMode === "awd" && awdData && (() => {
                const vd = awdData.varByKey[awdColorByKey];
                if (!vd) return null;
                if (vd.type === 'cat') {
                  return (
                    <div className="footer-swatch-row">
                      {Object.entries(vd.cats).map(([k, c]) => (
                        <span key={k} className="footer-swatch-item">
                          <span className="footer-swatch-dot" style={{ background: c }}></span>
                          {climateTitleCase(k)}
                        </span>
                      ))}
                    </div>
                  );
                }
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '2px' }}>
                    <div style={{ fontSize: '9px', fontWeight: '600', color: 'var(--text-main)' }}>{vd.label}</div>
                    <div className="footer-gradient-bar" style={{ background: `linear-gradient(90deg, ${vd.colors.join(', ')})`, width: '100%' }}></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '8px', color: 'var(--text-muted)' }}>
                      <span>{vd.min?.toFixed?.(1) ?? "—"}</span>
                      <span>{vd.max?.toFixed?.(1) ?? "—"}</span>
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>

        <div className="footer-feature-item">
          <div className="feat-icon-wrapper">
            <Download className="footer-icon" />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h3>RASTER EXPORT</h3>
            {activeTiffUrl ? (
              <a 
                href={`${API_BASE}${activeTiffUrl}`} 
                download
                className="submit-btn-pill active text-center decoration-none"
                style={{ padding: '4px 8px', fontSize: '9px', width: 'auto', marginTop: '4px', display: 'inline-block' }}
              >
                Download TIFF
              </a>
            ) : (
              <button 
                disabled
                className="submit-btn-pill active"
                style={{ padding: '2px 8px', fontSize: '9px', width: 'auto', marginTop: '4px', cursor: 'not-allowed', opacity: 0.5 }}
              >
                Download TIFF
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
