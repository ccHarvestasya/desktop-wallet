/* eslint-disable @typescript-eslint/no-var-requires */

const actual = require('../../node_modules/js-sha3');

const isCrossRealmArrayBuffer = (value) =>
    value !== null &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object ArrayBuffer]' &&
    value.constructor !== ArrayBuffer;

const normalizeInput = (value) => (isCrossRealmArrayBuffer(value) ? new Uint8Array(value) : value);

const wrapHasher = (hasher) => {
    const wrappedHasher = new Proxy(hasher, {
        get(target, property) {
            const value = target[property];
            if ('update' === property) {
                return (input) => {
                    target.update(normalizeInput(input));
                    return wrappedHasher;
                };
            }
            return 'function' === typeof value ? value.bind(target) : value;
        },
    });
    return wrappedHasher;
};

const wrapAlgorithm = (algorithm) => {
    const wrappedAlgorithm = (...args) => algorithm(...args.map(normalizeInput));
    Object.keys(algorithm).forEach((property) => {
        if ('create' === property) {
            wrappedAlgorithm[property] = (...args) => wrapHasher(algorithm[property](...args));
            return;
        }
        wrappedAlgorithm[property] = (...args) => algorithm[property](...args.map(normalizeInput));
    });
    return wrappedAlgorithm;
};

module.exports = Object.keys(actual).reduce((exports, name) => {
    exports[name] = wrapAlgorithm(actual[name]);
    return exports;
}, {});
