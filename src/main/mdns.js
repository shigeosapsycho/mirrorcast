'use strict';

/**
 * mdns.js - Bonjour/DNS-SD advertisement using the pure-JS `multicast-dns`.
 *
 * This is the piece that makes an iPhone show "MirrorCast" under
 * Control Center → Screen Mirroring. No Apple Bonjour SDK required, so it
 * works identically on Windows and macOS.
 *
 * `multicast-dns` is deliberately low level: it does not manage services for
 * us. We answer the raw DNS questions iOS multicasts (PTR / SRV / TXT / A)
 * and periodically announce ourselves unsolicited so we appear promptly.
 */

const os = require('os');
const makeMdns = require('multicast-dns');
const EventEmitter = require('events');
const {
  AIRPLAY_PORT,
  SERVICE_AIRPLAY,
  SERVICE_RAOP,
  MDNS_DOMAIN,
  SRCVERS,
  MODEL,
  FEATURES,
  STATUS_FLAGS,
} = require('../shared/constants');

const TTL = 120; // seconds - standard for DNS-SD records
const ANNOUNCE_INTERVAL_MS = 30 * 1000;

/**
 * Pick the primary non-internal IPv4 address. iOS needs a reachable A record;
 * link-local / internal interfaces won't route.
 */
function primaryIPv4() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ name, address: addr.address });
      }
    }
  }
  // Prefer common LAN adapters (Wi-Fi / Ethernet) over virtual ones.
  const preferred = candidates.find((c) =>
    /wi-?fi|wlan|en0|ethernet|eth0/i.test(c.name)
  );
  return (preferred || candidates[0] || { address: '127.0.0.1' }).address;
}

/**
 * Build the TXT record for `_airplay._tcp`. Order/keys chosen to match what
 * modern iOS mirroring expects.
 *
 * @param {object} opts
 * @param {string} opts.deviceId  MAC-style "AA:BB:CC:DD:EE:FF"
 * @param {string} opts.publicKeyHex  ed25519 public key, hex
 */
function airplayTxt({ deviceId, publicKeyHex }) {
  return {
    deviceid: deviceId,
    features: FEATURES,
    flags: STATUS_FLAGS,
    model: MODEL,
    srcvers: SRCVERS,
    protovers: '1.1',
    // pi / pk identify us for the pairing handshake.
    pi: deviceId.replace(/:/g, '').toLowerCase(),
    pk: publicKeyHex,
    // vv = "vodka version"; rsf/fv/am cosmetic but improve compatibility.
    vv: '2',
    rsf: '0x0',
    fv: 'p20.1.1',
    am: MODEL,
  };
}

/**
 * RAOP TXT (audio). The instance name for RAOP is conventionally
 * "<deviceid-without-colons>@<name>".
 */
function raopTxt() {
  return {
    txtvers: '1',
    ch: '2',            // channels
    cn: '0,1,2,3',      // supported audio codecs (PCM, ALAC, AAC, AAC-ELD)
    et: '0,3,5',        // supported encryption types
    md: '0,1,2',        // metadata types
    sr: '44100',        // sample rate
    ss: '16',           // sample size
    tp: 'UDP',
    vs: SRCVERS,
    am: MODEL,
    sf: '0x4',
  };
}

class MdnsAdvertiser extends EventEmitter {
  /**
   * @param {object} cfg
   * @param {string} cfg.name        Human receiver name (Control Center label)
   * @param {string} cfg.deviceId    MAC-style id
   * @param {string} cfg.publicKeyHex ed25519 public key hex
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.mdns = null;
    this.announceTimer = null;
    this.host = `${(os.hostname() || 'mirrorcast').split('.')[0]}.${MDNS_DOMAIN}`;
    this.ip = primaryIPv4();
  }

  get instanceAirplay() {
    return `${this.cfg.name}.${SERVICE_AIRPLAY}.${MDNS_DOMAIN}`;
  }

  get instanceRaop() {
    const id = this.cfg.deviceId.replace(/:/g, '');
    return `${id}@${this.cfg.name}.${SERVICE_RAOP}.${MDNS_DOMAIN}`;
  }

  get serviceAirplay() {
    return `${SERVICE_AIRPLAY}.${MDNS_DOMAIN}`;
  }

  get serviceRaop() {
    return `${SERVICE_RAOP}.${MDNS_DOMAIN}`;
  }

  start() {
    this.ip = primaryIPv4();
    this.mdns = makeMdns({ loopback: false, reuseAddr: true });

    this.mdns.on('error', (err) => this.emit('error', err));
    this.mdns.on('warning', (err) => this.emit('log', `mdns warning: ${err.message}`));
    this.mdns.on('query', (query) => this._onQuery(query));

    // Announce immediately, then on an interval, so we appear fast and stay
    // fresh even if the initial multicast is missed.
    this.announce();
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
    this.emit('log', `mDNS advertising "${this.cfg.name}" at ${this.ip} (${this.host})`);
  }

  /** Assemble our full answer set (used for both queries and announcements). */
  _answers() {
    const txtAir = airplayTxt(this.cfg);
    const txtRaop = raopTxt();
    return [
      // Service enumeration pointers
      { name: this.serviceAirplay, type: 'PTR', ttl: TTL, data: this.instanceAirplay },
      { name: this.serviceRaop, type: 'PTR', ttl: TTL, data: this.instanceRaop },
      // AirPlay instance
      {
        name: this.instanceAirplay,
        type: 'SRV',
        ttl: TTL,
        data: { port: AIRPLAY_PORT, target: this.host, priority: 0, weight: 0 },
      },
      { name: this.instanceAirplay, type: 'TXT', ttl: TTL, data: kvBuffers(txtAir) },
      // RAOP instance (audio)
      {
        name: this.instanceRaop,
        type: 'SRV',
        ttl: TTL,
        data: { port: AIRPLAY_PORT, target: this.host, priority: 0, weight: 0 },
      },
      { name: this.instanceRaop, type: 'TXT', ttl: TTL, data: kvBuffers(txtRaop) },
      // Host address
      { name: this.host, type: 'A', ttl: TTL, data: this.ip },
    ];
  }

  /** Push an unsolicited multicast announcement. */
  announce() {
    if (!this.mdns) return;
    this.mdns.respond({ answers: this._answers() });
  }

  /** Answer questions that match our services/instance/host. */
  _onQuery(query) {
    if (!this.mdns || !query.questions) return;
    const all = this._answers();
    const wanted = [];

    for (const q of query.questions) {
      const qn = (q.name || '').toLowerCase();
      for (const a of all) {
        const an = a.name.toLowerCase();
        const typeMatch = q.type === a.type || q.type === 'ANY';
        if (an === qn && typeMatch) wanted.push(a);
      }
    }

    if (wanted.length) {
      // Always include SRV+TXT+A alongside a matched PTR so iOS can resolve in
      // one round trip.
      const withGlue = dedupe([...wanted, ...this._glueFor(wanted)]);
      this.mdns.respond({ answers: withGlue });
    }
  }

  _glueFor(answers) {
    const glue = [];
    const all = this._answers();
    const hasPtr = answers.some((a) => a.type === 'PTR');
    if (hasPtr) {
      for (const a of all) {
        if (a.type === 'SRV' || a.type === 'TXT' || a.type === 'A') glue.push(a);
      }
    }
    return glue;
  }

  /** Update the advertised name live (e.g. user renamed in settings). */
  rename(name) {
    if (this.mdns) {
      // Goodbye the OLD instance records (ttl 0) so devices drop the stale
      // name promptly, then announce under the new name.
      try {
        const bye = this._answers().map((a) => ({ ...a, ttl: 0 }));
        this.mdns.respond({ answers: bye });
      } catch (_) { /* ignore */ }
    }
    this.cfg.name = name;
    if (this.mdns) {
      this.announce();
      this.emit('log', `mDNS renamed to "${name}"`);
    }
  }

  stop() {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    if (this.mdns) {
      try {
        // Send goodbye packets (ttl 0) so devices drop us promptly.
        const bye = this._answers().map((a) => ({ ...a, ttl: 0 }));
        this.mdns.respond({ answers: bye });
      } catch (_) { /* ignore */ }
      this.mdns.destroy();
      this.mdns = null;
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** multicast-dns wants TXT data as an array of "key=value" Buffers. */
function kvBuffers(obj) {
  return Object.entries(obj).map(([k, v]) => Buffer.from(`${k}=${v}`));
}

function dedupe(answers) {
  const seen = new Set();
  const out = [];
  for (const a of answers) {
    const key = `${a.type}:${a.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

module.exports = { MdnsAdvertiser, primaryIPv4 };
