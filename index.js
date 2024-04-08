"use strict";
/**
 * Copyright (c) 2015-2017, Yaacov Zamir <kobi.zamir@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF  THIS SOFTWARE.
 */

/* Add bit operation functions to Buffer
 */
require("./utils/buffer_bit")();
var crc16 = require("./utils/crc16");
var modbusSerialDebug = require("debug")("modbus-serial");

var util = require("util");
var events = require("events");
var EventEmitter = events.EventEmitter || events;

var PORT_NOT_OPEN_MESSAGE = "Port Not Open";
var PORT_NOT_OPEN_ERRNO = "ECONNREFUSED";

var BAD_ADDRESS_MESSAGE = "Bad Client Address";
var BAD_ADDRESS_ERRNO = "ECONNREFUSED";

var TRANSACTION_TIMED_OUT_MESSAGE = "Timed out";
var TRANSACTION_TIMED_OUT_ERRNO = "ETIMEDOUT";

var modbusErrorMessages = [
    "Unknown error",
    "Illegal function (device does not support this read/write function)",
    "Illegal data address (register not supported by device)",
    "Illegal data value (value cannot be written to this register)",
    "Slave device failure (device reports internal error)",
    "Acknowledge (requested data will be available later)",
    "Slave device busy (retry request again later)"
];

var PortNotOpenError = function() {
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.message = PORT_NOT_OPEN_MESSAGE;
    this.errno = PORT_NOT_OPEN_ERRNO;
};

var BadAddressError = function() {
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.message = BAD_ADDRESS_MESSAGE;
    this.errno = BAD_ADDRESS_ERRNO;
};

var TransactionTimedOutError = function() {
    this.name = this.constructor.name;
    this.message = TRANSACTION_TIMED_OUT_MESSAGE;
    this.errno = TRANSACTION_TIMED_OUT_ERRNO;
};

var SerialPortError = function() {
    this.name = this.constructor.name;
    this.message = null;
    this.errno = "ECONNREFUSED";
};

/**
 * @fileoverview ModbusRTU module, exports the ModbusRTU class.
 * this class makes ModbusRTU calls fun and easy.
 *
 * Modbus is a serial communications protocol, first used in 1979.
 * Modbus is simple and robust, openly published, royalty-free and
 * easy to deploy and maintain.
 */

/**
 * Parse the data for a Modbus -
 * Read Coils (FC=02, 01)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Function} next the function to call next.
 */
function _readFC2(data, next) {
    var length = data.readUInt8(2);
    var contents = [];

    for (var i = 0; i < length; i++) {
        var reg = data[i + 3];

        for (var j = 0; j < 8; j++) {
            contents.push((reg & 1) === 1);
            reg = reg >> 1;
        }
    }

    if (next)
        next(null, { "data": contents, "buffer": data.slice(3, 3 + length) });
}

/**
 * Parse the data for a Modbus -
 * Read Input Registers (FC=04, 03)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Function} next the function to call next.
 */
function _readFC4(data, next) {
    var length = data.readUInt8(2);
    var contents = [];

    for (var i = 0; i < length; i += 2) {
        var reg = data.readUInt16BE(i + 3);
        contents.push(reg);
    }

    if (next)
        next(null, { "data": contents, "buffer": data.slice(3, 3 + length) });
}

/**
 * Parse the data for a Modbus -
 * Force Single Coil (FC=05)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Function} next the function to call next.
 */
function _readFC5(data, next) {
    var dataAddress = data.readUInt16BE(2);
    var state = data.readUInt16BE(4);

    if (next)
        next(null, { "address": dataAddress, "state": (state === 0xff00) });
}

/**
 * Parse the data for a Modbus -
 * Preset Single Registers (FC=06)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Function} next the function to call next.
 */
function _readFC6(data, next) {
    var dataAddress = data.readUInt16BE(2);
    var value = data.readUInt16BE(4);

    if (next)
        next(null, { "address": dataAddress, "value": value });
}

/**
 * Parse the data for a Modbus -
 * Preset Multiple Registers (FC=15, 16)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Function} next the function to call next.
 */
function _readFC16(data, next) {
    var dataAddress = data.readUInt16BE(2);
    var length = data.readUInt16BE(4);

    if (next)
        next(null, { "address": dataAddress, "length": length });
}

/**
 * Parse  the data fro Modbus -
 * Read File Records
 *
 * @param {Buffer4} buffer
 * @param {Function} next
 */
function _readFC20(data,  next) {
    var fileRespLength = parseInt(data.readUInt8(2));
    var result = [];
    for (var i = 5; i < fileRespLength + 5; i++) {
        var reg = data.readUInt8(i);
        result.push(reg);
    }
    if(next)
        next(null, { "data": result, "length": fileRespLength });
}

/**
 * Parse the data for a Modbus -
 * Read Device Identification (FC=43)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Modbus} modbus the client in case we need to read more device information
 * @param {Function} next the function to call next.
 */
function _readFC43(data, modbus, next) {
    var address = parseInt(data.readUInt8(0));
    var readDeviceIdCode = parseInt(data.readUInt8(3));
    var conformityLevel = parseInt(data.readUInt8(4));
    var moreFollows = parseInt(data.readUInt8(5));
    var nextObjectId = parseInt(data.readUInt8(6));
    var numOfObjects = parseInt(data.readUInt8(7));

    var startAt = 8;
    var result = {};
    for (var i = 0; i < numOfObjects; i++) {
        var objectId = parseInt(data.readUInt8(startAt));
        var objectLength = parseInt(data.readUInt8(startAt + 1));
        const startOfData = startAt + 2;
        result[objectId] = data.toString("ascii", startOfData, startOfData + objectLength);
        startAt = startOfData + objectLength;
    }

    // is it saying to follow and did you previously get data
    // if you did not previously get data go ahead and halt to prevent an infinite loop
    if (moreFollows && numOfObjects) {
        const cb = function(err, data) {
            data.data = Object.assign(data.data, result);
            return next(err, data);
        };
        modbus.writeFC43(address, readDeviceIdCode, nextObjectId, cb);
    } else if (next) {
        next(null, { data: result, conformityLevel });
    }
}

/**
 * Parse the data for a Modbus -
 * Encapsulation for RFID (FC=67)
 *
 * @param {Buffer} data the data buffer to parse.
 * @param {Function} next the function to call next.
 */
 function _readFC67(data, next) {
  // 1 byte modbus id
  // 1 byte for fc (in this case always 67 (0x43))
  // n bytes data
  // 2 bytes crc

  var length = data.length - 4;
  var contents = [];

  for (var i = 0; i < length; i++) {
      var reg = data.readUInt8(2 + i);
      contents.push(reg);
  }

  if (next) {
    next(null, { "data": contents, "buffer": data.slice(2, 2 + length) });
  }
}

/**
 * Wrapper method for writing to a port with timeout. <code><b>[this]</b></code> has the context of ModbusRTU
 * @param {Buffer} buffer The data to send
 * @private
 */
function _writeBufferToPort(buffer, transactionId) {
    var transaction = this._transactions[transactionId];

    if (transaction) {
        transaction._timeoutFired = false;
        transaction._timeoutHandle = _startTimeout(this._timeout, transaction);
        transaction.responses = [];

        // If in debug mode, stash a copy of the request payload
        if (this._debugEnabled) {
            transaction.request = Uint8Array.prototype.slice.call(buffer);
        }
    }

    modbusSerialDebug('send raw buffer', buffer)
    this._port.write(buffer);
}

/**
 * Starts the timeout timer with the given duration.
 * If the timeout ends before it was cancelled, it will call the callback with an error.
 * @param {number} duration the timeout duration in milliseconds.
 * @param {Function} next the function to call next.
 * @return {number} The handle of the timeout
 * @private
 */
function _startTimeout(duration, transaction) {
    if (!duration) {
        return undefined;
    }
    return setTimeout(function() {
        transaction._timeoutFired = true;
        if (transaction.next) {
            var err = new TransactionTimedOutError();
            if (transaction.request && transaction.responses) {
                err.modbusRequest = transaction.request;
                err.modbusResponses = transaction.responses;
            }
            transaction.next(err);
        }
    }, duration);
}

/**
 * Cancel the given timeout.
 *
 * @param {number} timeoutHandle The handle of the timeout
 * @private
 */
function _cancelTimeout(timeoutHandle) {
    clearTimeout(timeoutHandle);
}

// check expected length for responses with defined length in responses
function _isExpectedLengthReachedFC3(data) {
    return data.length >= 5 + data.readUInt8(2);
}
function _isExpectedLengthReachedFC16(data) {
    return data.length >= 8;
}
function _isExpectedLengthReachedFC67(data) {
    return data.length >= 5 + data.readUInt8(2);
}
const _isExpectedLengthReachedMap = {
    3: _isExpectedLengthReachedFC3,
    16: _isExpectedLengthReachedFC16,
    67: _isExpectedLengthReachedFC67
};

function _isExpectedLengthReached(data) {
    if (data.length < 3) {
        return false;
    }
    const code = data.readUInt8(1);
    return _isExpectedLengthReachedMap[code] ? _isExpectedLengthReachedMap[code](data) : true;
}
/**
 * Handle incoming data from the Modbus port.
 *
 * @param {Buffer} data The data received
 * @private
 */
function _onReceive(receivedBuffer) {
    var modbus = this;
    var error;

    // set locale helpers variables
    var transaction = modbus._transactions[modbus._port._transactionIdRead];

    // the _transactionIdRead can be missing, ignore wrong transaction it's
    if (!transaction) {
        return;
    }

    if (transaction.responses) {
        /* Stash what we received */
        transaction.responses.push(Uint8Array.prototype.slice.call(receivedBuffer));
    }
    
    // combine all buffers from transaction.responses
    const data = Buffer.concat(transaction.responses);

    modbusSerialDebug('receive raw buffer', receivedBuffer);
    modbusSerialDebug('combined raw buffer', data);

    /* What do we do next? */
    var next = function(err, res) {
        if (transaction.next) {
            /* Include request/response data if enabled */
            if (transaction.request && transaction.responses) {
                if (err) {
                    err.modbusRequest = transaction.request;
                    err.modbusResponses = transaction.responses;
                }

                if (res) {
                    res.request = transaction.request;
                    res.responses = transaction.responses;
                }
            }

            /* Pass the data on */
            return transaction.next(err, res);
        }
    };

    /* cancel the timeout */
    _cancelTimeout(transaction._timeoutHandle);
    transaction._timeoutHandle = undefined;

    /* check if the timeout fired */
    if (transaction._timeoutFired === true) {
        // we have already called back with an error, so don't generate a new callback
        return;
    }

    // check if expected length reached or if we need to collect more data
    if (!_isExpectedLengthReached(data)) {
        // dont do anything, wait for more data
        return;
    }

    /* check minimal length
     */
    if (!transaction.lengthUnknown && data.length < 5) {
        error = "Data length error, expected " +
            transaction.nextLength + " got " + data.length;
        next(new Error(error));
        return;
    }

    // if crc is OK, read address and function code
    const address = data.readUInt8(0);
    const code = data.readUInt8(1);
    
    /* check message CRC
      * if CRC is bad raise an error
      */
    var crcIn = data.readUInt16LE(data.length - 2);
    if (crcIn !== crc16(data.slice(0, -2))) {
        error = "CRC error";
        next(new Error(error));
        return;
    }

    /* check for modbus exception
     */
    if (data.length >= 5 &&
        code === (0x80 | transaction.nextCode)) {
        var errorCode = data.readUInt8(2);
        if (transaction.next) {
            error = new Error("Modbus exception " + errorCode + ": " + (modbusErrorMessages[errorCode] || "Unknown error"));
            error.modbusCode = errorCode;
            next(error);
        }
        return;
    }

    /* check message length
     * if we do not expect this data
     * raise an error
     */
    if (!transaction.lengthUnknown && data.length !== transaction.nextLength) {
        error = "Data length error, expected " +
            transaction.nextLength + " got " + data.length;
        next(new Error(error));
        return;
    }

    /* check message address
     * if we do not expect this message
     * raise an error
     */
    if (address !== transaction.nextAddress) {
        error = "Unexpected data error, expected " +
              "address " + transaction.nextAddress + " got " + address;
        if (transaction.next)
            next(new Error(error));
        return;
    }

    /* check message code
     * if we do not expect this message
     * raise an error
     */
    if (code !== transaction.nextCode) {
        error = "Unexpected data error, expected " +
            "code " + transaction.nextCode + " got " + code;
        if (transaction.next)
            next(new Error(error));
        return;
    }

    /* parse incoming data
     */

    switch (code) {
        case 1:
        case 2:
            // Read Coil Status (FC=01)
            // Read Input Status (FC=02)
            _readFC2(data, next);
            break;
        case 3:
        case 4:
            // Read Input Registers (FC=04)
            // Read Holding Registers (FC=03)
            _readFC4(data, next);
            break;
        case 5:
            // Force Single Coil
            _readFC5(data, next);
            break;
        case 6:
            // Preset Single Register
            _readFC6(data, next);
            break;
        case 15:
        case 16:
            // Force Multiple Coils
            // Preset Multiple Registers
            _readFC16(data, next);
            break;
        case 20:
            _readFC20(data, transaction.next);
            break;
        case 43:
            // read device identification
            _readFC43(data, modbus, next);
        case 67:
            // Encapsulation for RFID
            _readFC67(data, next);
            break;
    }
}

/**
 * Handle SerialPort errors.
 *
 * @param {Error} error The error received
 * @private
 */
function _onError(e) {
    var err = new SerialPortError();
    err.message = e.message;
    err.stack = e.stack;
    this.emit("error", err);
}

/**
 * Class making ModbusRTU calls fun and easy.
 *
 * @param {SerialPort} port the serial port to use.
 */
var ModbusRTU = function(port) {
    // the serial port to use
    this._port = port;

    // state variables
    this._transactions = {};
    this._timeout = null; // timeout in msec before unanswered request throws timeout error
    this._unitID = 1;

    // Flag to indicate whether debug mode (pass-through of raw
    // request/response) is enabled.
    this._debugEnabled = false;

    this._onReceive = _onReceive.bind(this);
    this._onError = _onError.bind(this);

    EventEmitter.call(this);
};
util.inherits(ModbusRTU, EventEmitter);

/**
 * Open the serial port and register Modbus parsers
 *
 * @param {Function} callback the function to call next on open success
 *      of failure.
 */
ModbusRTU.prototype.open = function(callback) {
    var modbus = this;

    // open the serial port
    modbus._port.open(function(error) {
        if (error) {
            modbusSerialDebug({ action: "port open error", error: error });
            /* On serial port open error call next function */
            if (callback)
                callback(error);
        } else {
            /* init ports transaction id and counter */
            modbus._port._transactionIdRead = 1;
            modbus._port._transactionIdWrite = 1;

            /* On serial port success
             * (re-)register the modbus parser functions
             */
            modbus._port.removeListener("data", modbus._onReceive);
            modbus._port.on("data", modbus._onReceive);

            /* On serial port error
             * (re-)register the error listner function
             */
            modbus._port.removeListener("error", modbus._onError);
            modbus._port.on("error", modbus._onError);

            /* Hook the close event so we can relay it to our callers. */
            modbus._port.once("close", modbus.emit.bind(modbus, "close"));

            /* On serial port open OK call next function with no error */
            if (callback)
                callback(error);
        }
    });
};


/**
 * Check if port debug mode is enabled
 */
Object.defineProperty(ModbusRTU.prototype, "isDebugEnabled", {
    enumerable: true,
    get: function() {
        return this._debugEnabled;
    },
    set: function(enable) {
        enable = Boolean(enable);
        this._debugEnabled = enable;
    }
});


/**
 * Check if port is open
 */
Object.defineProperty(ModbusRTU.prototype, "isOpen", {
    enumerable: true,
    get: function() {
        if (this._port) {
            return this._port.isOpen;
        }

        return false;
    }
});


/**
 * Close the serial port
 *
 * @param {Function} callback the function to call next on close success
 *      or failure.
 */
ModbusRTU.prototype.close = function(callback) {
    // close the serial port if exist
    if (this._port) {
        this._port.removeAllListeners("data");
        this._port.close(callback);
    } else {
        // nothing needed to be done
        callback();
    }
};

/**
 * Destory the serial port
 *
 * @param {Function} callback the function to call next on close success
 *      or failure.
 */
ModbusRTU.prototype.destroy = function(callback) {
    // close the serial port if exist and it has a destroy function
    if (this._port && this._port.destroy) {
        this._port.removeAllListeners("data");
        this._port.destroy(callback);
    } else {
        // nothing needed to be done
        callback();
    }
};

/**
 * Write a Modbus "Read Coil Status" (FC=01) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first coil.
 * @param {number} length the total number of coils requested.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC1 = function(address, dataAddress, length, next) {
    this.writeFC2(address, dataAddress, length, next, 1);
};

/**
 * Write a Modbus "Read Input Status" (FC=02) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first digital input.
 * @param {number} length the total number of digital inputs requested.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC2 = function(address, dataAddress, length, next, code) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    // sanity check
    if (typeof address === "undefined" || typeof dataAddress === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }

    // function code defaults to 2
    code = code || 2;

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        nextLength: 3 + parseInt((length - 1) / 8 + 1) + 2,
        next: next
    };

    var codeLength = 6;
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt16BE(dataAddress, 2);
    buf.writeUInt16BE(length, 4);

    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Read Holding Registers" (FC=03) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first register.
 * @param {number} length the total number of registers requested.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC3 = function(address, dataAddress, length, next) {
    this.writeFC4(address, dataAddress, length, next, 3);
};

/**
 * Write a Modbus "Read Input Registers" (FC=04) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first register.
 * @param {number} length the total number of registers requested.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC4 = function(address, dataAddress, length, next, code) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    // sanity check
    if (typeof address === "undefined" || typeof dataAddress === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }

    // function code defaults to 4
    code = code || 4;

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        nextLength: 3 + 2 * length + 2,
        next: next
    };

    var codeLength = 6;
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt16BE(dataAddress, 2);
    buf.writeUInt16BE(length, 4);

    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Force Single Coil" (FC=05) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the coil.
 * @param {number} state the boolean state to write to the coil (true / false).
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC5 = function(address, dataAddress, state, next) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    // sanity check
    if (typeof address === "undefined" || typeof dataAddress === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }

    var code = 5;

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        nextLength: 8,
        next: next
    };

    var codeLength = 6;
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt16BE(dataAddress, 2);

    if (state) {
        buf.writeUInt16BE(0xff00, 4);
    } else {
        buf.writeUInt16BE(0x0000, 4);
    }

    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Preset Single Register " (FC=6) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the register.
 * @param {number} value the value to write to the register.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC6 = function(address, dataAddress, value, next) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    // sanity check
    if (typeof address === "undefined" || typeof dataAddress === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }

    var code = 6;

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        nextLength: 8,
        next: next
    };

    var codeLength = 6; // 1B deviceAddress + 1B functionCode + 2B dataAddress + 2B value
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt16BE(dataAddress, 2);

    if (Buffer.isBuffer(value)) {
        value.copy(buf, 4);
    } else {
        buf.writeUInt16BE(value, 4);
    }

    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Force Multiple Coils" (FC=15) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first coil.
 * @param {Array} array the array of boolean states to write to coils.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC15 = function(address, dataAddress, array, next) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    // sanity check
    if (typeof address === "undefined" || typeof dataAddress === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }

    var code = 15;
    var i = 0;

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        nextLength: 8,
        next: next
    };

    var dataBytes = Math.ceil(array.length / 8);
    var codeLength = 7 + dataBytes;
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt16BE(dataAddress, 2);
    buf.writeUInt16BE(array.length, 4);
    buf.writeUInt8(dataBytes, 6);

    // clear the data bytes before writing bits data
    for (i = 0; i < dataBytes; i++) {
        buf.writeUInt8(0, 7 + i);
    }

    for (i = 0; i < array.length; i++) {
        // buffer bits are already all zero (0)
        // only set the ones set to one (1)
        if (array[i]) {
            buf.writeBit(1, i, 7);
        }
    }

    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Preset Multiple Registers" (FC=16) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} dataAddress the Data Address of the first register.
 * @param {Array} array the array of values to write to registers.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC16 = function(address, dataAddress, array, next) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    // sanity check
    if (typeof address === "undefined" || typeof dataAddress === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }

    var code = 16;

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        nextLength: 8,
        next: next
    };

    var dataLength = array.length;
    if (Buffer.isBuffer(array)) {
        // if array is a buffer it has double length
        dataLength = array.length / 2;
    }

    var codeLength = 7 + 2 * dataLength;
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt16BE(dataAddress, 2);
    buf.writeUInt16BE(dataLength, 4);
    buf.writeUInt8(dataLength * 2, 6);

    // copy content of array to buf
    if (Buffer.isBuffer(array)) {
        array.copy(buf, 7);
    } else {
        for (var i = 0; i < dataLength; i++) {
            buf.writeUInt16BE(array[i], 7 + 2 * i);
        }
    }

    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write  mODBUS "Read Device Identification" (FC=20) to serial port
 * @param {number} address the slave unit address.
 * @param {Function} next;
 */
ModbusRTU.prototype.writeFC20 = function(address, fileNumber, recordNumber, next) {
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }
    // sanity check
    if (typeof address === "undefined") {
        if (next) next(new BadAddressError());
        return;
    }
    // function code defaults to 20
    var code = 20;
    var codeLength = 10;
    var byteCount = 7;
    var chunck = 100;

    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        lengthUnknown: true,
        next: next
    };
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes
    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt8(byteCount, 2);
    buf.writeUInt8(6, 3); // ReferenceType
    buf.writeUInt16BE(fileNumber, 4);
    buf.writeUInt16BE(recordNumber, 6);
    buf.writeUInt8(chunck, 9);
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Read Device Identification" (FC=43) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {number} deviceIdCode the read device access code.
 * @param {number} objectId the array of values to write to registers.
 * @param {Function} next the function to call next.
 */
ModbusRTU.prototype.writeFC43 = function(address, deviceIdCode, objectId, next) {
    // check port is actually open before attempting write
    if (this.isOpen !== true) {
        if (next) next(new PortNotOpenError());
        return;
    }

    var code = 0x2B; // 43

    // set state variables
    this._transactions[this._port._transactionIdWrite] = {
        nextAddress: address,
        nextCode: code,
        lengthUnknown: true,
        next: next
    };
    var codeLength = 5;
    var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes
    buf.writeUInt8(address, 0);
    buf.writeUInt8(code, 1);
    buf.writeUInt8(0x0E, 2); // 16 MEI Type
    buf.writeUInt8(deviceIdCode, 3);
    buf.writeUInt8(objectId, 4);
    // add crc bytes to buffer
    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);
    // write buffer to serial port
    _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

/**
 * Write a Modbus "Encapsulation for RFID" (FC=67) to serial port.
 *
 * @param {number} address the slave unit address.
 * @param {[number, number]} command the command to execute.
 * @param {Array} array the array of data values for command.
 * @param {Function} next the function to call next.
 */
 ModbusRTU.prototype.writeFC67 = function(address, command, array, next) {
  // check port is actually open before attempting write
  if (this.isOpen !== true) {
      if (next) next(new PortNotOpenError());
      return;
  }

  // sanity check
  if (typeof address === "undefined" || typeof command === "undefined") {
      if (next) next(new BadAddressError());
      return;
  }

  var code = 67;

  // set state variables
  this._transactions[this._port._transactionIdWrite] = {
      nextAddress: address,
      nextCode: code,
      lengthUnknown: true,
      next: next
  };

  var dataLength = array.length;

  var codeLength = 4 + dataLength;
  var buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

  buf.writeUInt8(address, 0);
  buf.writeUInt8(code, 1);
  buf.writeUInt8(command[0], 2);
  buf.writeUInt8(command[1], 3);

  // copy content of array to buf
  if (Buffer.isBuffer(array)) {
    array.copy(buf, 7);
  } else {
    for (var i = 0; i < dataLength; i++) {
      buf.writeUInt8(array[i], 4 + i);
    }
  }

  // add crc bytes to buffer
  buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

  // write buffer to serial port
  _writeBufferToPort.call(this, buf, this._port._transactionIdWrite);
};

// add the connection shorthand API
require("./apis/connection")(ModbusRTU);

// add the promise API
require("./apis/promise")(ModbusRTU);

// add worker API
require("./apis/worker")(ModbusRTU);

// exports
module.exports = ModbusRTU;
module.exports.TestPort = require("./ports/testport");
try {
    module.exports.RTUBufferedPort = require("./ports/rtubufferedport");
} catch (err) { }
module.exports.TcpPort = require("./ports/tcpport");
module.exports.TcpRTUBufferedPort = require("./ports/tcprtubufferedport");
module.exports.TelnetPort = require("./ports/telnetport");
module.exports.C701Port = require("./ports/c701port");

module.exports.ServerTCP = require("./servers/servertcp");
module.exports.default = module.exports;
