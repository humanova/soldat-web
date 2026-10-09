// The intro demos: the demo each version of Soldat played behind its menu (demos/intro.sdm),
// from 1.2.0, the first that recorded demos. A version that kept its predecessor's has none
// of its own here. web/intros/ has them as the games shipped them (gzipped); the page opens
// them like a demo file, converted to 1.7.1's layout (legacy.js). docs/DEMOS.md has where
// they come from.
//
// versions: the releases that came with it; released: the first one's release date;
// seconds: its length.
export const INTROS = [
  { file: 'intro-1.2.0.sdm.gz', versions: '1.2.0 and 1.2.1', released: '2004-01-21', map: 'Krab', seconds: 109 },
  { file: 'intro-1.3.0.sdm.gz', versions: '1.3.0 and 1.3.1', released: '2005-08-05', map: 'htf_Mare', seconds: 65 },
  { file: 'intro-1.4.0.sdm.gz', versions: '1.4.0 and 1.4.2', released: '2007-04-29', map: 'Bigfalls', seconds: 71 },
  { file: 'intro-1.4.1.sdm.gz', versions: '1.4.1', released: '2007-06-02', map: 'Bigfalls', seconds: 94 },
  { file: 'intro-1.5.0.sdm.gz', versions: '1.5.0', released: '2009-04-16', map: 'Cambodia', seconds: 91 },
  { file: 'intro-1.6.0.sdm.gz', versions: '1.6.0 to 1.6.3', released: '2011-09-04', map: 'Cambodia', seconds: 113 },
  { file: 'intro-1.6.4.sdm.gz', versions: '1.6.4 and 1.6.5', released: '2013-07-23', map: 'Cambodia', seconds: 205 },
  { file: 'intro-1.6.6.sdm.gz', versions: '1.6.6', released: '2013-10-13', map: 'htf_Boxed', seconds: 286 },
  { file: 'intro-1.6.7.sdm.gz', versions: '1.6.7 and 1.6.8', released: '2014-05-02', map: 'RatCave', seconds: 265 },
  { file: 'intro-1.6.9.sdm.gz', versions: '1.6.9 to 1.7.1', released: '2015-10-31', map: 'Cambodia', seconds: 110 },
];
