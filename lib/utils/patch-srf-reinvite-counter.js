/**
 * Repair drachtio-srf's per-dialog re-INVITE counter when a re-INVITE gets a non-2xx final.
 *
 * Background
 * ----------
 * Dialog#modify serializes re-INVITEs on a dialog with a counter plus a queue of waiters:
 *
 *   if (this._reinvitesInProgress.count++ > 0) {
 *     await new Promise((resolve) => this._reinvitesInProgress.admitOne.push(resolve));
 *   }                                                            (dialog.js:289-290)
 *
 * Every terminal path is supposed to release that slot via onReInviteComplete(), which decrements
 * the count and admits the next waiter. The non-2xx path does not:
 *
 *   callback(new SipError(res.status, res.reason));              (dialog.js:362)
 *
 * so `count` stays >= 1 for the life of the dialog. Every later modify() on that dialog then sees
 * `count++ > 0` and parks on the `admitOne` promise, which nothing will ever resolve - an
 * unbounded wait with no timeout, exactly the class of hang we are eliminating elsewhere.
 *
 * Why this matters now
 * --------------------
 * Previously the leak was mostly theoretical because re-INVITEs on these dialogs almost always
 * got a 200. We now deliberately answer 491 in the media-release glare and ESL-stall paths, so
 * the peer's modify() rejects with a SipError and the leak became reachable on a normal call.
 * A single 491 would otherwise wedge every subsequent re-INVITE on that dialog.
 *
 * Approach
 * --------
 * Wrap Dialog#modify rather than replacing it, so the ~120 lines of upstream offer/answer logic
 * stay untouched. On rejection we release the slot ourselves.
 *
 * Only SipError rejections are repaired, and that is what makes this safe: within modify(),
 * SipError is constructed at exactly one site - the leaking non-2xx path at dialog.js:362. The
 * other terminal paths reject with a plain Error and have already released the slot themselves
 * (dialog.js:294-296 destroyed-while-waiting, :311 unhold-not-held, :338-340 request failure), so
 * they are left alone and cannot be double-decremented.
 *
 * Clamped at zero so that if upstream ever fixes dialog.js:362 this patch degrades to a no-op
 * instead of corrupting the count in the other direction.
 */

const Dialog = require('drachtio-srf/lib/dialog');
const {SipError} = require('drachtio-srf');

let applied = false;

function applySrfReinviteCounterPatch(logger) {
  if (applied) return;

  if (typeof Dialog?.prototype?.modify !== 'function') {
    logger.error('patch-srf-reinvite-counter: unexpected drachtio-srf shape, NOT patching');
    return;
  }

  const origModify = Dialog.prototype.modify;

  Dialog.prototype.modify = function(...args) {
    const releaseSlot = (err) => {
      if (!(err instanceof SipError)) return;
      const inProgress = this._reinvitesInProgress;
      if (!inProgress) return;

      inProgress.count = Math.max(0, inProgress.count - 1);
      const admitOne = inProgress.admitOne.shift();
      if (admitOne) setImmediate(admitOne);

      logger.info({
        dialogId: this.id,
        status: err.status,
        count: inProgress.count,
        waiting: inProgress.admitOne.length
      }, 'patch-srf-reinvite-counter: released re-INVITE slot after non-2xx final');
    };

    /* modify() is overloaded - (sdp, opts, cb) / (sdp, cb) / (opts, cb) / (sdp) - so the callback
       is identified positionally as a trailing function, matching upstream's own detection. */
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = (err, ...rest) => {
        if (err) releaseSlot(err);
        return last(err, ...rest);
      };
      return origModify.apply(this, args);
    }

    return origModify.apply(this, args)
      .catch((err) => {
        releaseSlot(err);
        throw err;
      });
  };

  applied = true;
  logger.info('patch-srf-reinvite-counter: Dialog#modify releases its slot on non-2xx finals');
}

module.exports = applySrfReinviteCounterPatch;
