/* One CRO's mail + calendar. Dana Whitfield, CRO at Northstar Systems. Today = Thu 2026-08-06. */
var EXEC = 'dana@northstar.io';
var TODAY = '2026-08-06';

var MESSAGES = [
  { id: 'm1', threadId: 't1', subject: 'Meridian MSA — redlines', from: 'paul.oyelaran@meridianhealth.com',
    to: [EXEC], date: '2026-07-28T14:12', attach: false,
    body: "Thanks for sending the MSA over. Our counsel is reviewing now. We will have their comments back to you by Friday Jul 31 at the latest." },
  { id: 'm2', threadId: 't1', subject: 'Meridian MSA — redlines', from: EXEC,
    to: ['paul.oyelaran@meridianhealth.com'], date: '2026-08-03T09:05', attach: false,
    body: "Hi Paul — checking in on the redlines. Anything I can unblock on our side? Happy to get our legal team on a call if that speeds things up." },

  { id: 'm3', threadId: 't2', subject: 'Q3 board deck — revenue section', from: 'marcus.bell@northstar.io',
    to: [EXEC], date: '2026-08-03T16:40', attach: false,
    body: "Board packet goes out Friday morning. Can you get me the revenue section by Thursday EOD so I have time to review it?" },
  { id: 'm4', threadId: 't2', subject: 'Q3 board deck — revenue section', from: EXEC,
    to: ['marcus.bell@northstar.io'], date: '2026-08-03T17:22', attach: false,
    body: "Yes — I'll send it Thursday EOD. Pulling the final pipeline numbers Wednesday so they're current." },

  { id: 'm5', threadId: 't3', subject: 'Intro to Halcyon Robotics', from: 'greg.tan@bridgepointvc.com',
    to: [EXEC], date: '2026-07-30T11:15', attach: false,
    body: "Would love an intro to Sana at Halcyon if you're willing — we think there's a real partnership there." },
  { id: 'm6', threadId: 't3', subject: 'Intro to Halcyon Robotics', from: EXEC,
    to: ['greg.tan@bridgepointvc.com'], date: '2026-07-30T18:02', attach: false,
    body: "Happy to make that intro. I'll connect you with Sana this week." },

  { id: 'm7', threadId: 't4', subject: 'Cedarline renewal — revised pricing', from: EXEC,
    to: ['priya.raman@cedarline.com'], date: '2026-08-04T10:30', attach: false,
    body: "Good talking Friday. I'll get you revised pricing by Wednesday that reflects the expanded seat count." },
  { id: 'm8', threadId: 't4', subject: 'Cedarline renewal — revised pricing', from: EXEC,
    to: ['priya.raman@cedarline.com'], date: '2026-08-05T15:48', attach: true,
    body: "Revised pricing attached — this reflects the 240 seats we discussed. Let me know if the structure works." },

  { id: 'm9', threadId: 't5', subject: 'Vector Freight QBR — Friday', from: 'lena.borg@vectorfreight.com',
    to: [EXEC], date: '2026-07-31T13:20', attach: false,
    body: "Looking forward to Friday. Could you send an agenda ahead of the QBR so our team can prep? Our COO is joining." },

  { id: 'm10', threadId: 't6', subject: 'Reference call — Juniper Telecom', from: 'dani.okafor@northstar.io',
    to: [EXEC], date: '2026-08-01T09:44', attach: false,
    body: "Juniper's CTO wants a reference conversation before they sign. Can you do a call with him next week?" },
  { id: 'm11', threadId: 't6', subject: 'Reference call — Juniper Telecom', from: EXEC,
    to: ['dani.okafor@northstar.io'], date: '2026-08-01T10:10', attach: false,
    body: "Sure — I'll do the call. Tuesday or Wednesday next week works on my end, let's find time." },

  { id: 'm12', threadId: 't7', subject: 'Blue Harbor — exec sponsor', from: 'rachel.kim@northstar.io',
    to: [EXEC], date: '2026-07-24T15:05', attach: false,
    body: "Blue Harbor is asking for an executive sponsor conversation before they commit to the enterprise tier." },
  { id: 'm13', threadId: 't7', subject: 'Blue Harbor — exec sponsor', from: EXEC,
    to: ['rachel.kim@northstar.io'], date: '2026-07-24T19:30', attach: false,
    body: "Makes sense. I'll loop in our CEO for the exec sponsor conversation and get something on the books." },

  { id: 'm14', threadId: 't8', subject: 'Sales comp plan — sign-off needed', from: 'hr@northstar.io',
    to: [EXEC], date: '2026-08-02T08:30', attach: true,
    body: "Attached is the revised sales compensation plan for FY27. We need your sign-off by Aug 8 to hit the payroll cycle." },
  { id: 'm15', threadId: 't8', subject: 'Sales comp plan — sign-off needed', from: EXEC,
    to: ['hr@northstar.io'], date: '2026-08-02T12:15', attach: false,
    body: "Got it. I'll review and get back to you before the deadline." },

  { id: 'm16', threadId: 't9', subject: 'Ironwood pilot — next steps', from: EXEC,
    to: ['t.vela@ironwoodmfg.com'], date: '2026-07-29T11:00', attach: false,
    body: "Wanted to follow up on the pilot scope we discussed. Does Thursday work for a call to walk through the rollout plan?" },

  { id: 'm17', threadId: 't10', subject: 'RevOps Summit — speaker confirmation', from: 'program@revopssummit.com',
    to: [EXEC], date: '2026-08-01T10:00', attach: false,
    body: "We have you slotted for the closing keynote. Can you confirm your final talk title and a short bio by Aug 5? We go to print right after." },

  { id: 'm18', threadId: 't11', subject: 'Solstice partner agreement', from: 'j.mercer@solsticemedia.com',
    to: [EXEC], date: '2026-07-27T16:30', attach: false,
    body: "Everything looks good on our end. We'll send the countersigned copy back Monday." },

  { id: 'm19', threadId: 't12', subject: 'Sales offsite — venue', from: 'rachel.kim@northstar.io',
    to: [EXEC], date: '2026-08-04T09:10', attach: false,
    body: "We're down to two venues for the September offsite. Both are holding space but need a decision soon." },
  { id: 'm20', threadId: 't12', subject: 'Sales offsite — venue', from: EXEC,
    to: ['rachel.kim@northstar.io'], date: '2026-08-04T14:00', attach: false,
    body: "I'll book the venue by end of week — let me look at the numbers once more." },

  { id: 'm21', threadId: 't13', subject: 'Northwind expansion — security review', from: EXEC,
    to: ['s.abioye@northwindlogistics.com'], date: '2026-07-30T13:00', attach: false,
    body: "Thanks for flagging. I'll send the completed security questionnaire tomorrow so your team can start review." },
  { id: 'm22', threadId: 't13', subject: 'Northwind expansion — security review', from: EXEC,
    to: ['s.abioye@northwindlogistics.com'], date: '2026-07-31T09:20', attach: true,
    body: "Questionnaire attached, along with our latest pen test summary." },

  { id: 'm23', threadId: 't14', subject: 'SOC 2 report request', from: 'compliance@arbordiagnostics.com',
    to: [EXEC], date: '2026-07-28T10:00', attach: false,
    body: "Before we can proceed to procurement, we'll get you our updated SOC 2 report this week for your vendor file." },
  { id: 'm24', threadId: 't14', subject: 'SOC 2 report request', from: 'compliance@arbordiagnostics.com',
    to: [EXEC], date: '2026-08-01T14:30', attach: true,
    body: "SOC 2 Type II attached as promised. Let us know if you need anything else." },

  { id: 'm25', threadId: 't15', subject: 'Larkspur renewal — decision call', from: 'm.osei@larkspurretail.com',
    to: [EXEC], date: '2026-08-05T17:00', attach: false,
    body: "Confirming our call tomorrow afternoon. Our CFO will be joining to discuss the multi-year term." }
];

var EVENTS = [
  { id: 'e1', title: 'Vector Freight — Q3 QBR', start: '2026-08-07T10:00',
    attendees: [EXEC, 'lena.borg@vectorfreight.com', 'dani.okafor@northstar.io'], agenda: false },
  { id: 'e2', title: 'Larkspur Retail — renewal decision', start: '2026-08-06T16:00',
    attendees: [EXEC, 'm.osei@larkspurretail.com'], agenda: false },
  { id: 'e3', title: 'Cobalt Mining — exec sync', start: '2026-08-04T11:00',
    attendees: [EXEC, 'k.arnesen@cobaltmining.com'], agenda: true },
  { id: 'e4', title: 'Weekly revenue staff', start: '2026-08-06T09:00',
    attendees: [EXEC, 'dani.okafor@northstar.io', 'rachel.kim@northstar.io'], agenda: true },
  { id: 'e5', title: 'Northwind — expansion kickoff', start: '2026-08-11T13:00',
    attendees: [EXEC, 's.abioye@northwindlogistics.com'], agenda: true }
];

/* Who matters, and how much. An assistant curates this — it is the judgment that
 * separates a promise to the board from one to a conference organiser. Keyed by
 * address for individuals, domain for whole accounts. */
var RELATIONSHIPS = {
  'marcus.bell@northstar.io':   { tier: 'exec',        label: 'CFO' },
  'greg.tan@bridgepointvc.com': { tier: 'investor',    label: 'Investor' },
  'meridianhealth.com':         { tier: 'key_account', label: 'Key account' },
  'larkspurretail.com':         { tier: 'key_account', label: 'Key account' },
  'vectorfreight.com':          { tier: 'customer',    label: 'Customer' },
  'cedarline.com':              { tier: 'customer',    label: 'Customer' },
  'northwindlogistics.com':     { tier: 'customer',    label: 'Customer' },
  'cobaltmining.com':           { tier: 'customer',    label: 'Customer' },
  'ironwoodmfg.com':            { tier: 'prospect',    label: 'Prospect' },
  'arbordiagnostics.com':       { tier: 'prospect',    label: 'Prospect' },
  'solsticemedia.com':          { tier: 'partner',     label: 'Partner' },
  'northstar.io':               { tier: 'internal',    label: 'Internal' }
};

if (typeof module !== 'undefined') module.exports = {
  EXEC: EXEC, TODAY: TODAY, MESSAGES: MESSAGES, EVENTS: EVENTS, RELATIONSHIPS: RELATIONSHIPS
};
