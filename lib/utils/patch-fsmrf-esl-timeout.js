/**
 * Bound the ESL api path in drachtio-fsmrf so a missing freeswitch api response can never hang
 * a SIP transaction indefinitely.
 *
 * Background
 * ----------
 * Endpoint#modify() is two phases:
 *   phase 1 - this._dialog.modify(newSdp)      SIP re-INVITE to freeswitch (has SIP timers)
 *   phase 2 - this.getChannelVariables(true)   ESL uuid_set_media_stats + uuid_dump (NO timer)
 *
 * Neither Endpoint#api() nor drachtio-modesl's Connection#api() carries a timeout. If the
 * channel is destroyed between phase 1 and phase 2 - e.g. a media release racing an in-dialog
 * re-INVITE - freeswitch never delivers the api response and the awaiting promise is never
 * settled. The re-INVITE transaction then stalls until the far end tears the call down.
 *
 * This is unfixed upstream: drachtio-fsmrf 5.0.1 carries a byte-identical api() and modify(),
 * so upgrading the dependency is not an alternative to this patch.
 *
 * Applied as a runtime prototype patch rather than an edit under node_modules/ so that it lives
 * in the repo and survives `npm install`.
 *
 * FIFO safety
 * -----------
 * drachtio-modesl queues api callbacks on an uncorrelated FIFO and pairs each incoming api
 * response with whatever callback is at the head:
 *
 *   Connection.prototype.api    -> this.apiCallbackQueue.push(cb)            (Connection.js:255)
 *   on('esl::event::api::response') -> var fn = self.apiCallbackQueue.shift() (Connection.js:146)
 *
 * So a response can only be mispaired if a callback we gave up on is still at the head when a
 * LATER call's response arrives. Three properties bound that risk:
 *
 *  1. The queue is per-socket, not global. Server.prototype._onConnection does
 *     `var conn = new Connection(socket)` (Server.js:62-63) and the constructor does
 *     `this.apiCallbackQueue = []` (Connection.js:58), and MediaServer#createEndpoint gives every
 *     Endpoint its own outbound connection via produceEndpoint. The MediaServer's long-lived
 *     inbound connection is a separate Connection instance, and this patch only wraps
 *     Endpoint.prototype.api - never Connection.prototype.api - so the shared inbound connection
 *     can never be affected. Worst-case blast radius is one call leg.
 *  2. We do NOT unregister the timed-out callback. It stays queued, so if the response merely
 *     arrives late it consumes its own slot and alignment is preserved exactly. (Splicing it out
 *     would be strictly worse: a late response would then be handed to the NEXT caller.)
 *  3. For the remaining case - the response never arrives while the socket is still open - we
 *     refuse to enqueue anything behind the stranded callback (see STRANDED below). That turns a
 *     potential silent mispairing into an explicit, bounded error. When the late response finally
 *     drains the stranded slot the counter returns to zero and the connection is usable again.
 *
 * In practice the response goes missing because the channel was destroyed, which closes the
 * socket; Endpoint's own `esl::end` handler then nulls `_conn` (endpoint.js:106-115) and
 * Endpoint#api short-circuits on `if (!this._conn)` (endpoint.js:1390), so no further call is ever
 * enqueued on that connection anyway.
 */

const Endpoint = require('drachtio-fsmrf/lib/endpoint');

/**
 * Healthy phase-2 channel-variable queries complete in single-digit milliseconds, and a normal
 * _onReinvite finishes 10-15ms before media release. Upstream abandons a stalled re-INVITE after
 * roughly 1.36s, so the bound has to land well inside that budget: 1000ms is ~100x the observed
 * healthy latency while still leaving ~360ms to build and send the 200 OK.
 */
const DEFAULT_ESL_API_TIMEOUT_MS = 1000;

const getTimeoutMs = () => {
  const n = parseInt(process.env.JAMBONES_ESL_API_TIMEOUT_MS, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ESL_API_TIMEOUT_MS;
};

/* Counts callbacks we have abandoned that are still sitting in this connection's
   apiCallbackQueue. While non-zero the queue head no longer belongs to the next caller, so we
   refuse new api calls on that connection rather than risk a mispaired response. */
const STRANDED = Symbol('jambonzStrandedApiCallbacks');

const makeErr = (message, code) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

let applied = false;

function applyFsmrfEslTimeoutPatch(logger) {
  if (applied) return;

  if (typeof Endpoint?.prototype?.api !== 'function' ||
      typeof Endpoint?.prototype?.modify !== 'function' ||
      typeof Endpoint?.prototype?.getChannelVariables !== 'function') {
    logger.error('patch-fsmrf-esl-timeout: unexpected drachtio-fsmrf shape, NOT patching');
    return;
  }

  const timeoutMs = getTimeoutMs();
  const origApi = Endpoint.prototype.api;

  /* Endpoint#api with a bounded timeout. Delegates to the original so the `!this._conn` guard and
     debug logging keep tracking upstream; we only add the timer. */
  Endpoint.prototype.api = function(command, args, callback) {
    if (typeof args === 'function') {
      callback = args;
      args = [];
    }

    const __x = (cb) => {
      const conn = this._conn;

      /* Never queue behind a callback we have already abandoned - the response would be paired
         with the wrong caller. Fail fast and explicitly instead. */
      if (conn && conn[STRANDED] > 0) {
        logger.info({
          epUuid: this.uuid,
          command,
          stranded: conn[STRANDED]
        }, 'patch-fsmrf-esl-timeout: refusing api call, connection has an abandoned response pending');
        return cb(makeErr(
          `freeswitch api queue has ${conn[STRANDED]} abandoned response(s) pending: ${command}`,
          'ESL_API_QUEUE_SUSPECT'));
      }

      let settled = false;
      let counted = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (conn) {
          conn[STRANDED] = (conn[STRANDED] || 0) + 1;
          counted = true;
        }
        logger.info({
          epUuid: this.uuid,
          command,
          timeoutMs,
          epState: this.state,
          epConnected: this.connected,
          stranded: conn ? conn[STRANDED] : 0
        }, 'patch-fsmrf-esl-timeout: freeswitch api response timed out');
        cb(makeErr(`freeswitch api timeout after ${timeoutMs}ms: ${command}`, 'ESL_API_TIMEOUT'));
      }, timeoutMs);

      /* Deliberately still registered with drachtio-modesl - see FIFO safety above. If the
         response turns up late it consumes its own queue slot, which is what keeps the FIFO
         aligned, and clears the stranded count. */
      origApi.call(this, command, args, (err, ...response) => {
        clearTimeout(timer);
        if (counted && conn) {
          conn[STRANDED] = Math.max(0, (conn[STRANDED] || 0) - 1);
        }
        if (settled) {
          logger.info({
            epUuid: this.uuid,
            command,
            stranded: conn ? conn[STRANDED] : 0
          }, 'patch-fsmrf-esl-timeout: late api response drained the abandoned slot, queue re-aligned');
          return;
        }
        settled = true;
        cb(err, ...response);
      });
    };

    if (callback) {
      __x(callback);
      return this;
    }

    return new Promise((resolve, reject) => {
      __x((err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  };

  /* Endpoint#modify that tolerates a phase-2 failure.
     Phase 1 has already produced a valid answer SDP from freeswitch by then; phase 2 is only
     bookkeeping of cached channel variables. If the endpoint still looks alive we resolve
     best-effort with that answer so the 200 OK still goes out, leaving the previously cached
     local/remote values untouched rather than overwriting them with undefined. If the endpoint is
     gone the answer would point at a dead media port, so we fail fast instead. */
  Endpoint.prototype.modify = async function(newSdp) {
    const result = await this._dialog.modify(newSdp);

    try {
      const obj = await this.getChannelVariables(true);

      /* An empty/unparseable api response is phase-2 giving us nothing useful; treat it the same
         as a timeout rather than clobbering a valid cached SDP with undefined. */
      if (!obj || !obj['variable_rtp_local_sdp_str']) {
        const err = new Error('freeswitch api response contained no channel variables');
        err.code = 'ESL_API_EMPTY_RESPONSE';
        throw err;
      }

      this.local.sdp = obj['variable_rtp_local_sdp_str'];
      this.local.mediaIp = obj['variable_local_media_ip'];
      this.local.mediaPort = obj['variable_local_media_port'];

      this.remote.sdp = obj['variable_switch_r_sdp'];
      this.remote.mediaIp = obj['variable_remote_media_ip'];
      this.remote.mediaPort = obj['variable_remote_media_port'];

      this.dtmfType = obj['variable_dtmf_type'];
    } catch (err) {
      const detail = {
        epUuid: this.uuid,
        code: err?.code,
        message: err?.message,
        epState: this.state,
        epConnected: this.connected
      };
      if (this.connected === false) {
        logger.info(detail,
          'patch-fsmrf-esl-timeout: Endpoint#modify - endpoint no longer connected, failing modify');
        throw err;
      }
      logger.info(detail,
        'patch-fsmrf-esl-timeout: Endpoint#modify - channel variable refresh failed, ' +
        'returning freeswitch answer best-effort');
    }

    return result;
  };

  applied = true;
  logger.info({timeoutMs}, 'patch-fsmrf-esl-timeout: bounded drachtio-fsmrf Endpoint#api / #modify');
}

module.exports = applyFsmrfEslTimeoutPatch;
