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

function parseTime(value) {
  const match = TIME_REGEX.exec(value.trim());
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return hours * 60 + minutes;
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
    lookup: parseNumber(elements.lookup.value),
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

  if (values.lookup === null || values.lookup < 0) {
    showError("lookup", "Enter a number ≥ 0.");
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
  }

  return { leadTimes, chosenDayOffset, chosenFlight };
}

function computeServiceLevels(leadTimes, weights, resolution) {
  const maxLead = Math.max(...leadTimes);
  const targets = [];
  const serviceLevels = [];
  for (let t = 1; t <= maxLead + 0.001; t += resolution) {
    const sl = serviceLevelAt(t, leadTimes, weights);
    targets.push(Number.parseFloat(t.toFixed(2)));
    serviceLevels.push(sl);
  }
  return { targets, serviceLevels };
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
  const distributionLabels = data.distribution.map((_, idx) =>
    idx % 120 === 0 ? formatTime(idx) : ""
  );

  const distributionDataset = {
    label: "Order distribution",
    data: data.distribution,
    borderColor: "rgba(141, 246, 255, 0.9)",
    backgroundColor: "rgba(141, 246, 255, 0.15)",
    tension: 0.25,
    fill: true,
    pointRadius: 0,
  };

  if (!charts.distribution) {
    charts.distribution = new Chart(document.getElementById("distribution-chart"), {
      type: "line",
      data: {
        labels: distributionLabels,
        datasets: [distributionDataset],
      },
      options: chartOptions({ yLabel: "Density" }),
    });
  } else {
    charts.distribution.data.labels = distributionLabels;
    charts.distribution.data.datasets[0].data = data.distribution;
    charts.distribution.update();
  }

  const serviceDataset = {
    label: "Service level",
    data: data.serviceLevels,
    borderColor: "rgba(255, 75, 210, 0.9)",
    backgroundColor: "rgba(255, 75, 210, 0.15)",
    tension: 0.25,
    fill: true,
    pointRadius: 0,
  };

  if (!charts.service) {
    charts.service = new Chart(document.getElementById("service-chart"), {
      type: "line",
      data: {
        labels: data.targets,
        datasets: [serviceDataset],
      },
      options: chartOptions({ xLabel: "Lead time (h)", yLabel: "Service level (%)" }),
    });
  } else {
    charts.service.data.labels = data.targets;
    charts.service.data.datasets[0].data = data.serviceLevels;
    charts.service.update();
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
      options: chartOptions({ yLabel: "% of requests" }),
    });
  } else {
    charts.flight.data.labels = flightLabels;
    charts.flight.data.datasets[0].data = data.flightShares;
    charts.flight.update();
  }
}

function chartOptions({ xLabel = "", yLabel = "" }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
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
        callbacks: {
          label: (context) => `${context.parsed.y.toFixed(2)}`,
        },
      },
    },
  };
}

function updateTable(targets, serviceLevels) {
  const tbody = document.querySelector("#service-table tbody");
  tbody.innerHTML = "";
  targets.forEach((target, index) => {
    const row = document.createElement("tr");
    const targetCell = document.createElement("td");
    targetCell.textContent = target.toFixed(2);
    const slCell = document.createElement("td");
    slCell.textContent = serviceLevels[index].toFixed(2);
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

function disableOutputs(message) {
  elements.outputArea.classList.add("output-disabled");
  elements.outputError.textContent = message;
  elements.lookupResult.textContent = "--";
}

function enableOutputs() {
  elements.outputArea.classList.remove("output-disabled");
  elements.outputError.textContent = "";
}

function saveState(values) {
  const payload = {
    ...values,
    sigma: values.sigma ?? DEFAULTS.sigma,
    resolution: values.resolution ?? DEFAULTS.resolution,
    lookup: values.lookup ?? DEFAULTS.lookup,
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
      elements.shareLink.textContent = "Share link";
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

  const { leadTimes, chosenDayOffset, chosenFlight } = leadTimeResult;
  const { targets, serviceLevels } = computeServiceLevels(
    leadTimes,
    distribution,
    values.resolution
  );
  const flightShare = computeFlightShares(depTODs, chosenDayOffset, chosenFlight, distribution);
  const flightLabels = depTODs.map(formatTime).concat("First flight next day");
  const flightShares = [...flightShare.shares, flightShare.nextDayShare];

  currentData = { leadTimes, distribution };
  updateLookup(values.lookup, leadTimes, distribution);
  updateCharts({
    distribution,
    targets,
    serviceLevels,
    flightLabels,
    flightShares,
  });
  updateTable(targets, serviceLevels);
  enableOutputs();
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
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

  const debouncedUpdate = debounce(updateApp, 150);

  Object.values(elements).forEach((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      el.addEventListener("input", debouncedUpdate);
      el.addEventListener("change", debouncedUpdate);
    }
  });

  elements.incoterm.addEventListener("change", (event) => {
    setIncotermDefaults(event.target.value);
    debouncedUpdate();
  });

  elements.distribution.addEventListener("change", (event) => {
    updateDistributionVisibility(event.target.value);
  });

  elements.shareLink.addEventListener("click", () => {
    copyShareLink(readInputs());
  });

  updateApp();
}

init();
