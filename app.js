const DEFAULTS = {
  incoterm: "DAP",
  rfc: 2,
  transit: 1,
  lat: 2,
  flight: 10,
  toa: 2,
  customs: 2,
  lastMile: 1,
  flights: "09:00, 21:00",
  distribution: "uniform",
  peak: "12:00",
  sigma: 3,
  cutoff: "15:00",
  resolution: 0.5,
  lookup: 24,
};

const INCOTERM_DEFAULTS = {
  DPU: { customs: 0, lastMile: 0 },
  DAP: { customs: 2, lastMile: 1 },
};

const stateKey = "leadTimeState";

const elements = {
  incoterm: document.getElementById("incoterm"),
  rfc: document.getElementById("rfc"),
  transit: document.getElementById("transit"),
  lat: document.getElementById("lat"),
  flight: document.getElementById("flight"),
  toa: document.getElementById("toa"),
  customs: document.getElementById("customs"),
  lastMile: document.getElementById("lastMile"),
  flights: document.getElementById("flights"),
  distribution: document.getElementById("distribution"),
  peak: document.getElementById("peak"),
  sigma: document.getElementById("sigma"),
  cutoff: document.getElementById("cutoff"),
  resolution: document.getElementById("resolution"),
  lookup: document.getElementById("lookup"),
  lookupResult: document.getElementById("lookup-result"),
  outputArea: document.getElementById("output-area"),
  outputError: document.getElementById("output-error"),
  shareLink: document.getElementById("share-link"),
  calculate: document.getElementById("calculate"),
};

const fieldGroups = {
  peak: document.querySelector('[data-field="peak"]'),
  sigma: document.querySelector('[data-field="sigma"]'),
  cutoff: document.querySelector('[data-field="cutoff"]'),
};

const errorElements = new Map(
  Array.from(document.querySelectorAll(".error")).map((node) => [node.dataset.errorFor, node])
);

let charts = {
  distribution: null,
  service: null,
  flight: null,
};

let currentData = null;

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DURATION_REGEX = /^(\d+):([0-5]\d)$/;

function parseTime(value) {
  const match = TIME_REGEX.exec(value.trim());
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return hours * 60 + minutes;
}

function parseDurationHours(value) {
  const match = DURATION_REGEX.exec(String(value).trim());
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return hours + minutes / 60;
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatAbsTime(minAbs) {
  const dayOffset = Math.floor(minAbs / 1440);
  const tod = ((minAbs % 1440) + 1440) % 1440;
  const base = formatTime(tod);
  if (dayOffset > 0) {
    return `${base} (+${dayOffset}d)`;
  }
  if (dayOffset < 0) {
    return `${base} (prev day)`;
  }
  return base;
}

function formatCutoffTOD(minTOD) {
  if (minTOD >= 0) {
    return formatTime(minTOD);
  }
  return `${formatTime(1440 + (minTOD % 1440))} (prev day)`;
}

function formatHours(hours) {
  return `${hours.toFixed(2)}h`;
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function formatDurationMinutes(minutes) {
  const mins = Math.round(minutes);
  const sign = mins < 0 ? "-" : "";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h <= 0) {
    return `${sign}${m}m`;
  }
  if (m === 0) {
    return `${sign}${h}h`;
  }
  return `${sign}${h}h ${m}m`;
}

function token(text, className) {
  const el = document.createElement("span");
  el.className = `explain-token ${className}`.trim();
  el.textContent = text;
  return el;
}

function addSentence(container, parts) {
  const p = document.createElement("p");
  parts.forEach((part) => {
    if (typeof part === "string") {
      p.appendChild(document.createTextNode(part));
    } else if (part instanceof Node) {
      p.appendChild(part);
    }
  });
  container.appendChild(p);
}

function addParagraph(container, parts) {
  addSentence(container, parts);
}

function computeExplainMetrics(values, depTODs, distribution, leadTimes, chosenDayOffset, chosenFlight, chosenDepAbs) {
  const bestLT = Math.min(...leadTimes);
  const worstLT = Math.max(...leadTimes);
  const mBest = leadTimes.indexOf(bestLT);
  const mWorst = leadTimes.indexOf(worstLT);

  const avgLT = leadTimes.reduce((sum, lt, idx) => sum + lt * distribution[idx], 0);
  const p50LT = weightedQuantile(leadTimes, distribution, 0.5);
  const p95LT = weightedQuantile(leadTimes, distribution, 0.95);

  let shareNextDay = 0;
  for (let i = 0; i < chosenDayOffset.length; i += 1) {
    if (chosenDayOffset[i] >= 1) {
      shareNextDay += distribution[i];
    }
  }

  const sameDayShares = depTODs.map(() => 0);
  for (let i = 0; i < chosenFlight.length; i += 1) {
    if (chosenDayOffset[i] === 0) {
      const idx = depTODs.indexOf(chosenFlight[i]);
      if (idx >= 0) {
        sameDayShares[idx] += distribution[i];
      }
    }
  }
  let topIndex = 0;
  for (let i = 1; i < sameDayShares.length; i += 1) {
    if (sameDayShares[i] > sameDayShares[topIndex]) {
      topIndex = i;
    }
  }
  const topFlightTOD = depTODs[topIndex] ?? null;
  const topFlightShare = sameDayShares[topIndex] ?? 0;

  const rfcTransitM = (values.rfc + values.transit) * 60;
  const afterDepH = values.flight + values.toa + values.customs + values.lastMile;

  const cutoffs = depTODs.map((depTOD) => {
    const cutoffTOD = depTOD - values.lat * 60 - rfcTransitM;
    return { depTOD, cutoffTOD };
  });

  // Narrative scenario using worst-case minute.
  const tOrderTOD = mWorst;
  const tTerminalAbs = tOrderTOD + rfcTransitM;
  const chosenDep = chosenDepAbs[mWorst];

  // Build the global departure schedule for up to 3 days (consistent with computeLeadTimes).
  const schedule = [];
  for (let d = 0; d <= 3; d += 1) {
    depTODs.forEach((tod) => schedule.push(d * 1440 + tod));
  }
  schedule.sort((a, b) => a - b);

  let missedDepAbs = null;
  for (let i = schedule.length - 1; i >= 0; i -= 1) {
    if (schedule[i] < chosenDep) {
      missedDepAbs = schedule[i];
      break;
    }
  }

  const latM = values.lat * 60;
  const missedAcceptanceClose = missedDepAbs !== null ? missedDepAbs - latM : null;
  const lateByM = missedAcceptanceClose !== null ? tTerminalAbs - missedAcceptanceClose : null;
  const waitToNextM = chosenDep - tTerminalAbs;

  return {
    bestLT,
    worstLT,
    mBest,
    mWorst,
    avgLT,
    p50LT,
    p95LT,
    shareNextDay,
    topFlightTOD,
    topFlightShare,
    cutoffs,
    rfcTransitH: values.rfc + values.transit,
    afterDepH,
    incoterm: values.incoterm,
    incotermAfterH: values.customs + values.lastMile,
    narrative: {
      tOrderTOD,
      tTerminalAbs,
      missedDepAbs,
      missedAcceptanceClose,
      lateByM,
      waitToNextM,
      chosenDepAbs: chosenDep,
    },
  };
}

function renderExplain({ valid, message, metrics, depTODs }) {
  const container = document.getElementById("explainBody");
  if (!container) {
    return;
  }
  container.replaceChildren();

  if (!valid) {
    addParagraph(container, [message || "Fix inputs to see the explanation."]);
    return;
  }

  const m = metrics;

  // Required sentences.
  addParagraph(container, [
    "Your best case lead time is ",
    token(formatHours(m.bestLT), "tok-metric"),
    ". ",
    "Your worst case lead time is ",
    token(formatHours(m.worstLT), "tok-metric"),
    " because you can miss a departure and get pushed to the next one.",
  ]);

  // Narrative example.
  const n = m.narrative;
  const orderAt = token(formatTime(n.tOrderTOD), "tok-good");
  const terminalAt = token(formatAbsTime(n.tTerminalAbs), "tok-metric");
  if (n.missedDepAbs !== null && n.missedAcceptanceClose !== null && n.lateByM !== null) {
    const missedDep = token(formatAbsTime(n.missedDepAbs), "tok-bad");
    const missedClose = token(formatAbsTime(n.missedAcceptanceClose), "tok-bad");
    const lateBy = token(formatDurationMinutes(Math.max(0, n.lateByM)), "tok-bad");
    const wait = token(formatDurationMinutes(Math.max(0, n.waitToNextM)), "tok-metric");
    const chosenDep = token(formatAbsTime(n.chosenDepAbs), "tok-good");

    addParagraph(container, [
      "Imagine you order at ",
      orderAt,
      ". You reach the cargo terminal at ",
      terminalAt,
      " (RFC + transport). Acceptance for the ",
      missedDep,
      " flight closes at ",
      missedClose,
      " (LAT), so you miss it by ",
      lateBy,
      ". Then you wait ",
      wait,
      " until the next departure at ",
      chosenDep,
      ".",
    ]);
  } else {
    const chosenDep = token(formatAbsTime(n.chosenDepAbs), "tok-good");
    const wait = token(formatDurationMinutes(Math.max(0, n.waitToNextM)), "tok-metric");
    addParagraph(container, [
      "Imagine you order at ",
      orderAt,
      ". You reach the cargo terminal at ",
      terminalAt,
      ". There isn’t an earlier departure you could have caught. You wait ",
      wait,
      " until the next departure at ",
      chosenDep,
      ".",
    ]);
  }

  // Smart statements (at least 4), grouped to reduce line breaks.
  const grouped = [
    "On average, your lead time will be ",
    token(formatHours(m.avgLT), "tok-metric"),
    " and ",
    token("95%", "tok-good"),
    " of your shipments will be faster than ",
    token(formatHours(m.p95LT ?? m.worstLT), "tok-metric"),
    ". ",
    "Fixed time you can’t escape: ",
    token(formatHours(m.rfcTransitH), "tok-metric"),
    " before departure + ",
    token(formatHours(m.afterDepH), "tok-metric"),
    " after departure. Everything else is just waiting for a flight. ",
    "With your current setup, ",
    token(formatPercent(m.shareNextDay * 100), "tok-bad"),
    " of orders miss all same-day flights and roll into tomorrow.",
  ];

  if (m.topFlightTOD !== null) {
    grouped.push(
      " ",
      "Most orders end up on the ",
      token(formatTime(m.topFlightTOD), "tok-good"),
      " departure (",
      token(formatPercent(m.topFlightShare * 100), "tok-metric"),
      " of requests)."
    );
  }
  addParagraph(container, grouped);

  // Cutoff lines for each flight (kept readable, but fewer hard line breaks).
  const cutoffParts = [];
  m.cutoffs.forEach(({ depTOD, cutoffTOD }, idx) => {
    if (idx > 0) {
      cutoffParts.push(" ");
    }
    cutoffParts.push("To catch the ");
    cutoffParts.push(token(formatTime(depTOD), "tok-good"));
    cutoffParts.push(" flight you must order by ");
    cutoffParts.push(token(formatCutoffTOD(Math.round(cutoffTOD)), cutoffTOD < 0 ? "tok-bad" : "tok-metric"));
    cutoffParts.push(".");
  });
  addParagraph(container, cutoffParts);

  // Incoterm impact.
  if (m.incotermAfterH > 0) {
    addParagraph(container, [
      "Door delivery (DAP) adds ",
      token(formatHours(m.incotermAfterH), "tok-metric"),
      " after destination availability.",
    ]);
  } else {
    addParagraph(container, [
      "DPU stops at the cargo terminal — no customs/last-mile included.",
    ]);
  }
}

function parseNumber(value) {
  if (value === "") {
    return null;
  }
  const num = Number.parseFloat(value);
  if (Number.isNaN(num)) {
    return null;
  }
  return num;
}

function parseHoursOrTime(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (text === "") {
    return null;
  }
  const duration = parseDurationHours(text);
  if (duration !== null) {
    return duration;
  }
  return parseNumber(text);
}

function showError(field, message) {
  const el = errorElements.get(field);
  if (el) {
    el.textContent = message;
  }
}

function clearErrors() {
  errorElements.forEach((el) => {
    el.textContent = "";
  });
}

function applyState(state) {
  elements.incoterm.value = state.incoterm;
  elements.rfc.value = state.rfc;
  elements.transit.value = state.transit;
  elements.lat.value = state.lat;
  elements.flight.value = state.flight;
  elements.toa.value = state.toa;
  elements.customs.value = state.customs;
  elements.lastMile.value = state.lastMile;
  elements.flights.value = state.flights;
  elements.distribution.value = state.distribution;
  elements.peak.value = state.peak;
  elements.sigma.value = state.sigma;
  elements.cutoff.value = state.cutoff;
  elements.resolution.value = state.resolution;
  elements.lookup.value = state.lookup;
  updateDistributionVisibility(state.distribution);
}

function updateDistributionVisibility(mode) {
  fieldGroups.peak.style.display = mode === "normal" ? "grid" : "none";
  fieldGroups.sigma.style.display = mode === "normal" ? "grid" : "none";
  fieldGroups.cutoff.style.display = mode === "cutoff" ? "grid" : "none";
}

function readInputs() {
  return {
    incoterm: elements.incoterm.value,
    rfc: parseNumber(elements.rfc.value),
    transit: parseNumber(elements.transit.value),
    lat: parseNumber(elements.lat.value),
    flight: parseNumber(elements.flight.value),
    toa: parseNumber(elements.toa.value),
    customs: parseNumber(elements.customs.value),
    lastMile: parseNumber(elements.lastMile.value),
    flights: elements.flights.value,
    distribution: elements.distribution.value,
    peak: elements.peak.value,
    sigma: parseNumber(elements.sigma.value),
    cutoff: elements.cutoff.value,
    resolution: parseNumber(elements.resolution.value),
    lookup: elements.lookup.value,
  };
}

function validateInputs(values) {
  clearErrors();
  let valid = true;

  const timeFields = [
    "rfc",
    "transit",
    "lat",
    "flight",
    "toa",
    "customs",
    "lastMile",
  ];

  timeFields.forEach((field) => {
    const value = values[field];
    if (value === null || value < 0) {
      showError(field, "Enter a number ≥ 0.");
      valid = false;
    }
  });

  const flightTimes = values.flights
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const invalidFlights = flightTimes.filter((time) => parseTime(time) === null);
  if (flightTimes.length === 0) {
    showError("flights", "Enter at least one HH:MM time.");
    valid = false;
  } else if (invalidFlights.length > 0) {
    showError("flights", `Invalid time(s): ${invalidFlights.join(", ")}`);
    valid = false;
  }

  if (values.distribution === "normal") {
    const peakMinute = parseTime(values.peak);
    if (peakMinute === null) {
      showError("peak", "Use HH:MM (24h).");
      valid = false;
    }
    if (values.sigma === null || values.sigma <= 0) {
      showError("sigma", "Sigma must be > 0.");
      valid = false;
    }
  }

  if (values.distribution === "cutoff") {
    if (parseTime(values.cutoff) === null) {
      showError("cutoff", "Use HH:MM (24h).");
      valid = false;
    }
  }

  const lookupHours = parseHoursOrTime(values.lookup);
  if (lookupHours === null || lookupHours < 0) {
    showError("lookup", "Use HH:MM (24h) or a number ≥ 0.");
    valid = false;
  }

  return { valid, flightTimes };
}

function buildDistribution(values) {
  const weights = new Array(1440).fill(0);
  if (values.distribution === "uniform") {
    weights.fill(1 / 1440);
    return weights;
  }

  if (values.distribution === "normal") {
    const mu = parseTime(values.peak);
    const sigmaMinutes = values.sigma * 60;
    let total = 0;
    for (let m = 0; m < 1440; m += 1) {
      const delta = Math.abs(m - mu);
      const distance = Math.min(delta, 1440 - delta);
      const weight = Math.exp(-0.5 * (distance / sigmaMinutes) ** 2);
      weights[m] = weight;
      total += weight;
    }
    return weights.map((w) => w / total);
  }

  const cutoffMinute = parseTime(values.cutoff);
  if (cutoffMinute === 0) {
    weights[0] = 1;
    return weights;
  }
  for (let m = 0; m < 1440; m += 1) {
    if (m < cutoffMinute) {
      weights[m] = 1;
    }
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((w) => w / total);
}

function computeLeadTimes(values, depTODs) {
  const rfcM = values.rfc * 60;
  const transitM = values.transit * 60;
  const latM = values.lat * 60;
  const flightM = values.flight * 60;
  const toaM = values.toa * 60;
  const customsM = values.customs * 60;
  const lastMileM = values.lastMile * 60;

  const leadTimes = new Array(1440);
  const chosenDayOffset = new Array(1440);
  const chosenFlight = new Array(1440);
  const chosenDepAbs = new Array(1440);

  for (let m = 0; m < 1440; m += 1) {
    const tReady = m + rfcM;
    const tTerminal = tReady + transitM;
    let selected = null;

    for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
      for (let i = 0; i < depTODs.length; i += 1) {
        const depTOD = depTODs[i];
        const depAbs = dayOffset * 1440 + depTOD;
        if (tTerminal <= depAbs - latM) {
          selected = { depAbs, dayOffset, depTOD };
          break;
        }
      }
      if (selected) {
        break;
      }
    }

    if (!selected) {
      return { error: "No feasible flight found within 3 days. Adjust your parameters." };
    }

    const tAvailable = selected.depAbs + flightM + toaM;
    const tDone = tAvailable + customsM + lastMileM;
    leadTimes[m] = (tDone - m) / 60;
    chosenDayOffset[m] = selected.dayOffset;
    chosenFlight[m] = selected.depTOD;
    chosenDepAbs[m] = selected.depAbs;
  }

  return { leadTimes, chosenDayOffset, chosenFlight, chosenDepAbs };
}

function computeServiceLevels(leadTimes, weights, resolution) {
  const maxLead = Math.max(...leadTimes);
  // round up to resolution to ensure we include the final point (where service level reaches 100%)
  const finalTarget = Math.ceil((maxLead + 1e-9) / resolution) * resolution;
  const targets = [];
  const serviceLevels = [];
  // start at 0 to include sub-hour targets when resolution < 1
  for (let t = 0; t <= finalTarget + 1e-9; t += resolution) {
    const sl = serviceLevelAt(t, leadTimes, weights);
    targets.push(Number.parseFloat(t.toFixed(2)));
    serviceLevels.push(sl);
  }

  // Trim to: last target with 0% service level -> first target with 100% service level.
  const zeroEps = 1e-6;
  const hundredEps = 100 - 1e-6;
  let startIndex = 0;
  for (let i = 0; i < serviceLevels.length; i += 1) {
    if (serviceLevels[i] <= zeroEps) {
      startIndex = i;
    }
  }
  let endIndex = serviceLevels.findIndex((sl) => sl >= hundredEps);
  if (endIndex < 0) {
    endIndex = serviceLevels.length - 1;
  }
  if (startIndex > endIndex) {
    startIndex = 0;
  }

  return {
    targets: targets.slice(startIndex, endIndex + 1),
    serviceLevels: serviceLevels.slice(startIndex, endIndex + 1),
  };
}

function serviceLevelAt(target, leadTimes, weights) {
  let total = 0;
  for (let i = 0; i < leadTimes.length; i += 1) {
    if (leadTimes[i] <= target) {
      total += weights[i];
    }
  }
  return total * 100;
}

function weightedQuantile(values, weights, quantile) {
  const pairs = values.map((value, idx) => ({ value, weight: weights[idx] }));
  pairs.sort((a, b) => a.value - b.value);
  const totalWeight = pairs.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) {
    return null;
  }
  const target = totalWeight * quantile;
  let acc = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    acc += pairs[i].weight;
    if (acc >= target) {
      return pairs[i].value;
    }
  }
  return pairs[pairs.length - 1].value;
}

const markerPlugin = {
  id: "leadTimeMarkers",
  afterDatasetsDraw(chart, args, pluginOptions) {
    const markers = (pluginOptions && pluginOptions.markers) || [];
    if (!markers.length) {
      return;
    }

    const { ctx, chartArea } = chart;
    const xScale = chart.scales.x;
    if (!ctx || !chartArea || !xScale) {
      return;
    }

    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.font = "12px Orbitron, Segoe UI, sans-serif";

    markers.forEach((marker) => {
      if (marker == null || marker.x == null) {
        return;
      }
      const x = xScale.getPixelForValue(marker.x);
      if (!Number.isFinite(x)) {
        return;
      }
      ctx.strokeStyle = marker.color;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle = marker.color;
      const label = `${marker.label}: ${marker.x.toFixed(2)}h`;
      const labelWidth = ctx.measureText(label).width;
      const labelX = Math.min(
        Math.max(x + 6, chartArea.left + 6),
        Math.max(chartArea.left + 6, chartArea.right - labelWidth - 6)
      );

      const pos = marker.labelPosition || "top";
      if (pos === "bottom") {
        ctx.textBaseline = "bottom";
        ctx.fillText(label, labelX, chartArea.bottom - 6);
      } else {
        ctx.textBaseline = "top";
        ctx.fillText(label, labelX, chartArea.top + 6);
      }
      ctx.setLineDash([6, 4]);
    });

    ctx.restore();
  },
};

if (typeof Chart !== "undefined" && Chart.register) {
  Chart.register(markerPlugin);
}

function computeFlightShares(depTODs, chosenDayOffset, chosenFlight, weights) {
  const shares = new Array(depTODs.length).fill(0);
  let nextDayShare = 0;
  const firstDep = depTODs[0];

  for (let i = 0; i < chosenFlight.length; i += 1) {
    const flight = chosenFlight[i];
    const dayOffset = chosenDayOffset[i];
    const weight = weights[i];
    if (dayOffset === 0) {
      const index = depTODs.indexOf(flight);
      if (index >= 0) {
        shares[index] += weight;
      }
    } else if (flight === firstDep) {
      nextDayShare += weight;
    }
  }

  return {
    shares: shares.map((value) => value * 100),
    nextDayShare: nextDayShare * 100,
  };
}

function updateCharts(data) {
  updateDistributionChart(data.distribution);

  const servicePoints = data.targets.map((target, idx) => ({
    x: target,
    y: data.serviceLevels[idx],
  }));

  const serviceDataset = {
    label: "Service level",
    data: servicePoints,
    borderColor: "rgba(255, 75, 210, 0.9)",
    backgroundColor: "rgba(255, 75, 210, 0.15)",
    tension: 0.25,
    fill: true,
    pointRadius: 0,
    pointHitRadius: 14,
  };

  if (!charts.service) {
    charts.service = new Chart(document.getElementById("service-chart"), {
      type: "line",
      data: {
        datasets: [serviceDataset],
      },
      options: chartOptions({
        kind: "service",
        xLabel: "Lead time (h)",
        yLabel: "Service level (%)",
      }),
    });
  } else {
    charts.service.data.datasets[0].data = servicePoints;
  }

  const flightLabels = data.flightLabels;
  const flightDataset = {
    label: "Share of requests",
    data: data.flightShares,
    backgroundColor: [
      "rgba(141, 246, 255, 0.65)",
      "rgba(255, 75, 210, 0.55)",
      "rgba(179, 140, 255, 0.55)",
      "rgba(255, 184, 77, 0.55)",
    ],
  };

  if (!charts.flight) {
    charts.flight = new Chart(document.getElementById("flight-chart"), {
      type: "bar",
      data: {
        labels: flightLabels,
        datasets: [flightDataset],
      },
      options: chartOptions({ kind: "flight", yLabel: "% of requests" }),
    });
  } else {
    charts.flight.data.labels = flightLabels;
    charts.flight.data.datasets[0].data = data.flightShares;
    charts.flight.update();
  }

  // Update lead-time markers (avg and p95) if we have the raw lead time distribution.
  if (charts.service && data.leadTimes && data.distribution) {
    const mean = data.leadTimes.reduce(
      (sum, value, idx) => sum + value * data.distribution[idx],
      0
    );
    const p95 = weightedQuantile(data.leadTimes, data.distribution, 0.95);
    charts.service.options.plugins.leadTimeMarkers.markers = [
      { label: "Avg", x: mean, color: "rgba(141, 246, 255, 0.9)", labelPosition: "bottom" },
      { label: "P95", x: p95 ?? mean, color: "rgba(255, 184, 77, 0.9)", labelPosition: "top" },
    ];
  }

  if (charts.service) {
    charts.service.update();
  }
}

function updateDistributionChart(distribution) {
  const distributionLabels = distribution.map((_, idx) => (idx % 120 === 0 ? formatTime(idx) : ""));
  const distributionDataset = {
    label: "Order distribution",
    data: distribution,
    borderColor: "rgba(141, 246, 255, 0.9)",
    backgroundColor: "rgba(141, 246, 255, 0.15)",
    tension: 0.25,
    fill: true,
    pointRadius: 0,
    pointHitRadius: 10,
  };

  if (!charts.distribution) {
    charts.distribution = new Chart(document.getElementById("distribution-chart"), {
      type: "line",
      data: { labels: distributionLabels, datasets: [distributionDataset] },
      options: chartOptions({ kind: "distribution", yLabel: "Density" }),
    });
  } else {
    charts.distribution.data.labels = distributionLabels;
    charts.distribution.data.datasets[0].data = distribution;
    charts.distribution.update();
  }
}

function chartOptions({ kind = "", xLabel = "", yLabel = "" }) {
  const isPercent = yLabel && yLabel.includes("%");
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction:
      kind === "service" || kind === "distribution"
        ? { mode: "index", intersect: false }
        : undefined,
    scales: {
      x: {
        title: {
          display: Boolean(xLabel),
          text: xLabel,
          color: "#b1a9d6",
        },
        ticks: { color: "#b1a9d6" },
        grid: { color: "rgba(141, 246, 255, 0.08)" },
      },
      y: {
        title: {
          display: Boolean(yLabel),
          text: yLabel,
          color: "#b1a9d6",
        },
        ticks: { color: "#b1a9d6" },
        grid: { color: "rgba(141, 246, 255, 0.08)" },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: kind === "service" || kind === "distribution" ? "index" : undefined,
        intersect: kind === "service" || kind === "distribution" ? false : undefined,
        callbacks: {
          title: (ctx) => {
            const item = ctx && ctx[0];
            if (!item) {
              return "";
            }
            if (kind === "service") {
              const x = item.parsed && item.parsed.x !== undefined ? item.parsed.x : Number(item.label);
              return Number.isFinite(x) ? `Target: ${x.toFixed(2)}h` : "Target";
            }
            if (kind === "flight") {
              return `Flight: ${item.label}`;
            }
            if (kind === "distribution") {
              return `Time: ${formatTime(item.dataIndex)}`;
            }
            return item.label ? String(item.label) : "";
          },
          label: (context) => {
            const val = context.parsed && context.parsed.y !== undefined ? context.parsed.y : context.parsed;
            const num = Number(val ?? 0);
            if (isPercent) {
              return `Value: ${num.toFixed(2)}%`;
            }
            if (kind === "distribution") {
              return `Value: ${num.toFixed(6)}`;
            }
            return `Value: ${num.toFixed(2)}`;
          },
        },
      },
      leadTimeMarkers: { markers: [] },
    },
  };

  if (kind === "service") {
    opts.scales.x.type = "linear";
  }

  if (isPercent) {
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    opts.scales.y.ticks = opts.scales.y.ticks || {};
    opts.scales.y.ticks.callback = (v) => `${v}%`;
  }

  return opts;
}

function updateTable(targets, serviceLevels) {
  const tbody = document.querySelector("#service-table tbody");
  tbody.innerHTML = "";
  targets.forEach((target, index) => {
    const row = document.createElement("tr");
    const targetCell = document.createElement("td");
    targetCell.textContent = target.toFixed(2);
    const slCell = document.createElement("td");
    slCell.textContent = `${serviceLevels[index].toFixed(2)}%`;
    row.appendChild(targetCell);
    row.appendChild(slCell);
    tbody.appendChild(row);
  });
}

function updateLookup(target, leadTimes, weights) {
  if (target === null || target < 0) {
    elements.lookupResult.textContent = "--";
    return;
  }
  const service = serviceLevelAt(target, leadTimes, weights);
  elements.lookupResult.textContent = `${service.toFixed(2)}%`;
}

function refreshOrderBehaviorChart() {
  const values = readInputs();
  const mode = values.distribution;

  if (mode === "normal") {
    const peakMinute = parseTime(values.peak);
    const sigmaOk = values.sigma !== null && values.sigma > 0;
    const safeValues = {
      ...values,
      peak: peakMinute === null ? DEFAULTS.peak : values.peak,
      sigma: sigmaOk ? values.sigma : DEFAULTS.sigma,
    };
    updateDistributionChart(buildDistribution(safeValues));
    return;
  }

  if (mode === "cutoff") {
    // Refresh as soon as a valid cutoff time is entered.
    if (parseTime(values.cutoff) === null) {
      return;
    }
    updateDistributionChart(buildDistribution(values));
    return;
  }

  // Uniform mode.
  updateDistributionChart(buildDistribution(values));
}

function disableOutputs(message) {
  elements.outputArea.classList.add("output-disabled");
  elements.outputError.textContent = message;
  elements.lookupResult.textContent = "--";
  renderExplain({ valid: false, message });
}

function enableOutputs() {
  elements.outputArea.classList.remove("output-disabled");
  elements.outputArea.classList.remove("output-stale");
  elements.outputError.textContent = "";
}

function markOutputsStale() {
  elements.outputArea.classList.add("output-stale");
  elements.outputError.textContent = "Press Calculate to refresh outputs.";
  elements.lookupResult.textContent = "--";
  currentData = null;
  renderExplain({
    valid: false,
    message: "Press Calculate to refresh the explanation.",
  });
}

function saveState(values) {
  const payload = {
    ...values,
    sigma: values.sigma ?? DEFAULTS.sigma,
    resolution: values.resolution ?? DEFAULTS.resolution,
    lookup: values.lookup === "" ? "" : values.lookup ?? DEFAULTS.lookup,
  };
  localStorage.setItem(stateKey, JSON.stringify(payload));
}

function loadState() {
  const saved = localStorage.getItem(stateKey);
  let persisted = {};
  if (saved) {
    try {
      persisted = JSON.parse(saved);
    } catch {
      persisted = {};
    }
  }

  const params = new URLSearchParams(window.location.search);
  const urlValues = Object.fromEntries(params.entries());

  const merged = {
    ...DEFAULTS,
    ...persisted,
  };

  Object.entries(urlValues).forEach(([key, value]) => {
    if (key in merged) {
      const numberValue = Number.parseFloat(value);
      if (!Number.isNaN(numberValue) && value !== "") {
        merged[key] = numberValue;
      } else {
        merged[key] = value;
      }
    }
  });

  return merged;
}

function buildShareLink(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    params.set(key, String(value));
  });
  const url = new URL(window.location.href);
  url.search = params.toString();
  return url.toString();
}

function copyShareLink(values) {
  const url = buildShareLink(values);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url);
    elements.shareLink.textContent = "Link copied";
    setTimeout(() => {
      elements.shareLink.textContent = "Share link with these Parameters";
    }, 1500);
  } else {
    window.prompt("Copy link:", url);
  }
}

function updateApp() {
  const values = readInputs();
  const { valid, flightTimes } = validateInputs(values);
  saveState(values);
  updateDistributionVisibility(values.distribution);

  if (!valid) {
    disableOutputs("Fix the highlighted fields to see outputs.");
    currentData = null;
    return;
  }

  const depTODs = Array.from(new Set(flightTimes.map(parseTime))).sort((a, b) => a - b);
  if (depTODs.length === 0) {
    disableOutputs("Enter at least one valid flight time.");
    return;
  }

  const distribution = buildDistribution(values);
  const leadTimeResult = computeLeadTimes(values, depTODs);
  if (leadTimeResult.error) {
    disableOutputs(leadTimeResult.error);
    return;
  }

  const { leadTimes, chosenDayOffset, chosenFlight, chosenDepAbs } = leadTimeResult;
  const { targets, serviceLevels } = computeServiceLevels(
    leadTimes,
    distribution,
    values.resolution
  );
  const flightShare = computeFlightShares(depTODs, chosenDayOffset, chosenFlight, distribution);
  const flightLabels = depTODs.map(formatTime).concat("First flight next day");
  const flightShares = [...flightShare.shares, flightShare.nextDayShare];

  currentData = { leadTimes, distribution };
  updateLookup(parseHoursOrTime(values.lookup), leadTimes, distribution);
  updateCharts({
    distribution,
    targets,
    serviceLevels,
    leadTimes,
    flightLabels,
    flightShares,
  });
  updateTable(targets, serviceLevels);

  const explainMetrics = computeExplainMetrics(
    values,
    depTODs,
    distribution,
    leadTimes,
    chosenDayOffset,
    chosenFlight,
    chosenDepAbs
  );
  renderExplain({ valid: true, metrics: explainMetrics, depTODs });

  enableOutputs();
}

function setIncotermDefaults(incoterm) {
  const defaults = INCOTERM_DEFAULTS[incoterm];
  if (!defaults) {
    return;
  }
  elements.customs.value = defaults.customs;
  elements.lastMile.value = defaults.lastMile;
}

function init() {
  const initialState = loadState();
  applyState(initialState);
  setIncotermDefaults(initialState.incoterm);
  updateDistributionVisibility(initialState.distribution);
  refreshOrderBehaviorChart();

  Object.values(elements).forEach((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      if (el === elements.lookup) {
        return;
      }
      el.addEventListener("input", () => {
        saveState(readInputs());
        markOutputsStale();
      });
      el.addEventListener("change", () => {
        saveState(readInputs());
        markOutputsStale();
      });
    }
  });

  elements.incoterm.addEventListener("change", (event) => {
    setIncotermDefaults(event.target.value);
    saveState(readInputs());
    markOutputsStale();
  });

  elements.distribution.addEventListener("change", (event) => {
    updateDistributionVisibility(event.target.value);
    refreshOrderBehaviorChart();
  });

  elements.peak.addEventListener("input", () => {
    if (elements.distribution.value === "normal") {
      refreshOrderBehaviorChart();
    }
  });

  elements.sigma.addEventListener("input", () => {
    if (elements.distribution.value === "normal") {
      refreshOrderBehaviorChart();
    }
  });

  elements.lookup.addEventListener("input", () => {
    const values = readInputs();
    saveState(values);
    if (currentData) {
      updateLookup(parseHoursOrTime(values.lookup), currentData.leadTimes, currentData.distribution);
    } else {
      elements.lookupResult.textContent = "--";
    }
  });

  elements.shareLink.addEventListener("click", () => {
    copyShareLink(readInputs());
  });

  elements.calculate.addEventListener("click", updateApp);

  // special-case cutoff input: update distribution chart immediately when in cutoff mode
  elements.cutoff.addEventListener("input", () => {
    saveState(readInputs());
    if (elements.distribution.value === "cutoff") {
      refreshOrderBehaviorChart();
      // also update lookup if we already have lead times computed
      if (currentData && currentData.leadTimes) {
        const values = readInputs();
        const distribution = buildDistribution(values);
        updateLookup(parseHoursOrTime(values.lookup), currentData.leadTimes, distribution);
      }
    } else {
      markOutputsStale();
    }
  });

  markOutputsStale();
}

init();
