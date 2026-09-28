/**
 * Traditional "connect the dots" stick-figure shapes for the 12 zodiac
 * constellations, keyed by ../sky.ts's `Sign` (same 12 names, e.g. "Scorpio"
 * not "Scorpius", "Capricorn" not "Capricornus").
 *
 * Source: d3-celestial's `constellations.lines.json`
 * (https://github.com/ofrohn/d3-celestial/blob/master/data/constellations.lines.json,
 * MIT licensed), which itself derives constellation line figures from real
 * star positions (Yale Bright Star Catalogue / HYG database) rather than an
 * invented shape -- consistent with this project's rule against inventing
 * astronomical reference data. Each point is a real star's right ascension
 * and declination (J2000, degrees), transformed as `x = -RA, y = -Dec` (RA
 * mirrored to match the sky's east-west chirality as seen looking up, not on
 * an outside-in star atlas; Dec negated so north is "up" on an HTML canvas,
 * whose y-axis grows downward). The source file stores RA in a -180..180
 * convention, so any constellation straddling the RA=180 meridian (only
 * Virgo, among these 12) needs its points unwrapped onto one continuous
 * numeric range *before* computing a bounding box -- skipping this collapsed
 * Virgo into a nearly-flat line the first time around, since its true ~45
 * degree RA span looked like ~353 degrees once a few points landed on the
 * wraparound's far side. Each constellation is then independently rescaled
 * to fit within roughly [-0.5, 0.5] on its longer axis, centered at (0, 0).
 * `segments` are index pairs into `points`, one per traditional stick-figure
 * line connecting two of its stars.
 *
 * Regenerate by re-running the extraction against a fresh copy of that file
 * if these ever need updating; the exact steps aren't scripted into this repo
 * since this is static reference data, not something computed at build time.
 */
import type { Sign } from "../sky";

export interface ConstellationShape {
  readonly points: readonly (readonly [number, number])[];
  readonly segments: readonly (readonly [number, number])[];
}

export const CONSTELLATIONS: Readonly<Record<Sign, ConstellationShape>> = {
  Aries: {
    points: [[-0.5, -0.2822], [0.2583, -0.0131], [0.4803, 0.175], [0.5, 0.2822]],
    segments: [[0, 1], [1, 2], [2, 3]],
  },
  Taurus: {
    points: [[-0.5, -0.1999], [-0.0353, -0.0604], [0.0193, -0.0411], [0.0861, -0.0338], [0.0624, -0.0915], [0.0197, -0.1408], [-0.4145, -0.4247], [0.23, 0.0607], [0.4823, 0.1437], [0.2113, 0.2564], [0.5, 0.1649], [0.4092, 0.4247]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [3, 7], [7, 8], [8, 9], [8, 10], [10, 11]],
  },
  Gemini: {
    points: [[0.5, -0.0051], [0.4106, -0.0054], [0.1787, -0.1211], [-0.1221, -0.3473], [-0.3815, -0.42], [-0.5, -0.2492], [-0.3961, -0.1992], [-0.2214, 0.0181], [-0.0444, 0.0806], [0.2475, 0.265], [0.1637, 0.42], [-0.199, 0.2588]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [7, 11]],
  },
  Cancer: {
    points: [[-0.268, 0.3635], [-0.0917, 0.0419], [-0.0739, -0.1273], [-0.117, -0.5], [0.268, 0.5]],
    segments: [[0, 1], [1, 2], [2, 3], [1, 4]],
  },
  Leo: {
    points: [[0.3172, 0.2279], [0.3257, 0.0722], [0.2231, -0.0277], [-0.2163, -0.0499], [-0.5, 0.1433], [-0.2174, 0.1155], [0.2497, -0.1438], [0.4439, -0.2279], [0.5, -0.1554]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [2, 6], [6, 7], [7, 8]],
  },
  Virgo: {
    points: [[0.5, -0.147], [0.4732, -0.0414], [0.3113, 0.0125], [0.1907, 0.0299], [0.0338, 0.1206], [-0.0507, 0.2453], [-0.3324, 0.1308], [-0.4823, 0.1232], [0.0769, -0.2453], [0.1134, -0.0776], [-0.1033, 0.011], [-0.2527, -0.0365], [-0.5, -0.0442]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [8, 9], [9, 3], [4, 10], [10, 11], [11, 12]],
  },
  Libra: {
    points: [[0.1311, 0.2796], [0.2928, -0.1735], [-0.0275, -0.5], [-0.2545, -0.2349], [-0.2728, 0.4195], [-0.2928, 0.5]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [1, 3]],
  },
  Scorpio: {
    points: [[0.5, -0.199], [0.4864, -0.3274], [0.4394, -0.431], [0.2946, -0.2181], [0.219, -0.1873], [0.1594, -0.1216], [0.0281, 0.1019], [0.0124, 0.24], [-0.0126, 0.3987], [-0.1741, 0.431], [-0.4056, 0.4222], [-0.5, 0.3165], [-0.4531, 0.2762], [-0.3715, 0.2053]],
    segments: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13]],
  },
  Sagittarius: {
    points: [[0.396, 0.23], [0.3386, 0.1466], [0.3664, -0.0133], [0.3052, -0.1679], [0.4298, -0.3209], [-0.1742, 0.5], [-0.1852, 0.3652], [0.0014, -0.0115], [0.1501, -0.1128], [-0.4604, 0.4091], [-0.4996, 0.1778], [-0.4654, -0.1371], [-0.2976, -0.1868], [-0.1974, -0.1999], [-0.112, -0.1737], [0.0658, -0.1372], [0.4996, 0.0076], [-0.0366, -0.089], [-0.0168, -0.297], [-0.0613, -0.3222], [-0.1304, -0.3948], [-0.1658, -0.4336], [-0.1662, -0.5], [0.0442, -0.3193], [0.0755, -0.2618]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [8, 3], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 8], [8, 2], [2, 16], [16, 1], [1, 7], [7, 17], [17, 15], [15, 18], [18, 19], [19, 20], [20, 21], [21, 22], [18, 23], [23, 24], [24, 15]],
  },
  Capricorn: {
    points: [[0.5, -0.3224], [0.4624, -0.2207], [0.3746, -0.085], [0.1818, 0.2487], [0.1177, 0.3224], [-0.2721, 0.1207], [-0.5, -0.1605], [-0.4223, -0.1365], [-0.2226, -0.1288], [-0.0403, -0.111]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 0]],
  },
  Aquarius: {
    points: [[0.5, -0.0092], [0.4714, -0.021], [0.2479, -0.0994], [0.0513, -0.2201], [-0.0398, -0.1955], [-0.0811, -0.227], [-0.1185, -0.2247], [-0.2177, -0.0533], [-0.3629, -0.0164], [-0.3144, 0.2591], [0.0476, 0.0913], [-0.0121, -0.0486], [-0.0606, -0.2591], [-0.392, 0.2344], [-0.5, 0.182]],
    segments: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [2, 10], [3, 11], [5, 12], [13, 8], [8, 14]],
  },
  Pisces: {
    points: [[-0.2289, -0.2001], [-0.2172, -0.3237], [-0.261, -0.2602], [-0.216, -0.1204], [-0.3285, 0.0073], [-0.4065, 0.1463], [-0.5, 0.2898], [-0.4523, 0.2803], [-0.3843, 0.2287], [-0.3212, 0.2139], [-0.2288, 0.1818], [-0.1683, 0.1747], [-0.0882, 0.1816], [0.1889, 0.1978], [0.2975, 0.2255], [0.3648, 0.2086], [0.4076, 0.231], [0.4254, 0.2782], [0.3706, 0.3237], [0.2858, 0.3119], [0.2614, 0.2736], [0.5, 0.2661]],
    segments: [[0, 1], [1, 2], [2, 0], [0, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 16], [16, 17], [17, 18], [18, 19], [19, 20], [20, 14], [17, 21]],
  },
};
