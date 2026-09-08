import Vue from 'vue';
import { TextEncoder, TextDecoder } from 'util';

console.log('Setting up global test stubs...');

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

if (typeof navigator === 'undefined') {
    global.navigator = { languages: ['en-US'] };
}

if (typeof window === 'undefined') {
    global.window = {};
}

if (typeof localStorage === 'undefined') {
    const values = {};
    global.localStorage = {
        getItem: (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null),
        setItem: (key, value) => {
            values[key] = String(value);
        },
        removeItem: (key) => {
            delete values[key];
        },
        clear: () => {
            Object.keys(values).forEach((key) => delete values[key]);
        },
        get length() {
            return Object.keys(values).length;
        },
    };
}

global.window.localStorage = global.localStorage;

if (typeof document !== 'undefined') {
    document.createRange = () => ({
        setStart: () => {
            return;
        },
        setEnd: () => {
            return;
        },
        commonAncestorContainer: {
            nodeName: 'BODY',
            ownerDocument: document,
        },
    });
}

// eslint-disable-next-line no-undef
Vue.$toast = jest.fn();
// eslint-disable-next-line no-undef
URL.createObjectURL = jest.fn();
