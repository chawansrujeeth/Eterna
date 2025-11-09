"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bpsDelta = bpsDelta;
function bpsDelta(a, b) {
    return (Math.abs(a - b) / b) * 10000; // basis points
}
