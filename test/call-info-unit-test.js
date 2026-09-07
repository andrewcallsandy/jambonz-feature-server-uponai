const test = require('tape');
const CallInfo = require('../lib/session/call-info');
const {CallDirection} = require('../lib/utils/constants');

const makeRequest = (parsedFrom, callingNumber = '+15551234567') => ({
  srf: {locals: {localSipAddress: '127.0.0.1'}},
  callingNumber,
  getParsedHeader: () => parsedFrom,
  get: (header) => header === 'Call-ID' ? 'test-call-id' : undefined
});

const makeChildCall = (req) => new CallInfo({
  direction: CallDirection.Outbound,
  parentCallInfo: {
    callSid: 'parent-call-sid',
    accountSid: 'account-sid',
    applicationSid: 'application-sid'
  },
  req,
  to: '+15557654321',
  callSid: 'child-call-sid'
});

test('CallInfo tolerates an absent From header on an outbound leg', (t) => {
  const callInfo = makeChildCall(makeRequest(undefined));

  t.equal(callInfo.from, '+15551234567', 'falls back to the request calling number');
  t.equal(callInfo.callerName, '', 'uses an empty caller name');
  t.equal(callInfo.callerId, '+15551234567', 'uses the request calling number as caller ID');
  t.end();
});

test('CallInfo tolerates an unparseable From URI on an outbound leg', (t) => {
  const callInfo = makeChildCall(makeRequest({uri: 'not-a-sip-uri'}));

  t.equal(callInfo.from, '+15551234567', 'falls back when the URI has no user');
  t.equal(callInfo.callerId, '+15551234567', 'preserves a usable caller ID');
  t.end();
});

test('CallInfo preserves a valid From header on an outbound leg', (t) => {
  const callInfo = makeChildCall(makeRequest({
    uri: 'sip:+15559876543@example.com',
    name: 'Test Caller'
  }));

  t.equal(callInfo.from, '+15559876543', 'uses the parsed From user');
  t.equal(callInfo.callerName, 'Test Caller', 'preserves the caller name');
  t.equal(callInfo.callerId, '+15551234567', 'preserves the request caller ID');
  t.end();
});
