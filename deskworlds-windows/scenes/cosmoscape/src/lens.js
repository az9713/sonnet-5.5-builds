// Weak gravitational lensing by a softened point mass, on the screen plane (pixels, relative to the lens).
// A point mass deflects light by alpha(theta) = theta_E^2 / theta. With a core radius c (so there is no
// singularity) alpha(theta) = theta_E^2 theta / (theta^2 + c^2). The lens equation is beta = theta - alpha(theta):
// beta is where a source really is, theta where we see an image of it. A source has two images for c = 0:
// outside the Einstein ring theta+ = (beta + sqrt(beta^2 + 4 theta_E^2)) / 2, stretched along the tangent, and
// inside it theta- = (beta - sqrt(...)) / 2 < 0 (on the far side of the lens), fainter. The vertex shader solves
// the same equation with the same Newton iteration; this module is the reference for the tests.

export function deflection(theta, E, core) { return E * E * theta / (theta * theta + core * core); }
// d beta / d theta = 1 - d alpha / d theta
export function betaSlope(theta, E, core) {
  const d = theta * theta + core * core;
  return 1 - E * E * (core * core - theta * theta) / (d * d);
}

// Signed image radius for source distance beta >= 0. which: 0 primary (outer), 1 secondary (inner, negative).
export function imageRadius(beta, E, core, which = 0, iterations = 6) {
  const disc = Math.sqrt(beta * beta + 4 * E * E);
  let theta = which === 0 ? 0.5 * (beta + disc) : 0.5 * (beta - disc);
  for (let i = 0; i < iterations; i++) {
    const f = theta - deflection(theta, E, core) - beta, df = betaSlope(theta, E, core);
    // Damped Newton: the slope vanishes at the critical curve of a cored lens.
    theta -= Math.max(-0.5 * (Math.abs(theta) + 1), Math.min(0.5 * (Math.abs(theta) + 1), f / (Math.abs(df) < 0.05 ? 0.05 * Math.sign(df || 1) : df)));
  }
  return theta;
}
// Image distortion: tangential stretch |theta| / beta, radial stretch 1 / |d beta / d theta|; magnification is the product.
export function distortion(theta, beta, E, core) {
  const tang = Math.abs(theta) / Math.max(beta, 1e-6), rad = 1 / Math.max(Math.abs(betaSlope(theta, E, core)), 1e-3);
  return { tangential: tang, radial: rad, magnification: tang * rad };
}
