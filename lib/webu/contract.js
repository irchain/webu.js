/*
    This file is part of webu.js.

    webu.js is free software: you can redistribute it and/or modify
    it under the terms of the GNU Lesser General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    webu.js is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public License
    along with webu.js.  If not, see <http://www.gnu.org/licenses/>.
*/
/**
 * @file contract.js
 * @author Marek Kotewicz <marek@ethdev.com>
 * @date 2014
 */

var utils = require('../utils/utils');
var coder = require('../solidity/coder');
var SolidityEvent = require('./event');
var SolidityFunction = require('./function');
var AllEvents = require('./allevents');

/**
 * Should be called to encode constructor params
 *
 * @method encodeConstructorParams
 * @param {Array} abi
 * @param params
 */
var encodeConstructorParams = function(abi, params) {
    return abi.filter(function(json) {
        return json.type === 'constructor' && json.inputs.length === params.length;
    }).map(function(json) {
        return json.inputs.map(function(input) {
            return input.type;
        });
    }).map(function(types) {
        return coder.encodeParams(types, params);
    })[0] || '';
};

/**
 * Should be called to add functions to contract object
 *
 * @method addFunctionsToContract
 * @param {Contract} contract
 */
var addFunctionsToContract = function(contract) {
    contract.abi.filter(function(json) {
        return json.type === 'function';
    }).map(function(json) {
        return new SolidityFunction(contract._irc, json, contract.address);
    }).forEach(function(f) {
        f.attachToContract(contract);
    });
};

/**
 * Should be called to add events to contract object
 *
 * @method addEventsToContract
 * @param {Contract} contract
 */
var addEventsToContract = function(contract) {
    var events = contract.abi.filter(function(json) { return json.type === 'event'; });

    var All = new AllEvents(contract._irc._requestManager, events, contract.address);
    All.attachToContract(contract);

    events.map(function(json) { return new SolidityEvent(contract._irc._requestManager, json, contract.address); })
          .forEach(function(e) { e.attachToContract(contract); });
};

/**
 * Should be called to check if the contract gets properly deployed on the blockchain.
 *
 * @method checkForContractAddress
 * @param {Object} contract
 * @param {Function} callback
 * @returns {Undefined}
 */
var checkForContractAddress = function(contract, callback) {
    var count         = 0,
        callbackFired = false;

    // wait for receipt
    var filter = contract._irc.filter('latest', function(e) {
        if (!e && !callbackFired) {
            count++;

            // stop watching after 50 blocks (timeout)
            if (count > 50) {
                filter.stopWatching(function() { });
                callbackFired = true;

                if (callback) {
                    callback(new Error('Contract transaction couldn\'t be found after 50 blocks'));
                } else {
                    throw new Error('Contract transaction couldn\'t be found after 50 blocks');
                }
            } else {
                contract._irc.getTransactionReceipt(
                    contract.transactionHash,
                    function(e, receipt) {
                        if (receipt && receipt.blockHash && !callbackFired) {

                            contract._irc.getCode(
                                receipt.contractAddress,
                                function(e, code) {
                                    if (callbackFired || !code) return;

                                    filter.stopWatching(function() { });
                                    callbackFired = true;

                                    if (code.length > 1) {
                                        contract.address = receipt.contractAddress;

                                        // attach events and methods again after we have
                                        addFunctionsToContract(contract);
                                        addEventsToContract(contract);

                                        // call callback for the second time
                                        if (callback) callback(null, contract);
                                    } else {
                                        if (callback) {
                                            callback(new Error('The contract code couldn\'t be stored, please check your gas amount.'));
                                        } else {
                                            throw new Error('The contract code couldn\'t be stored, please check your gas amount.');
                                        }
                                    }
                                });
                        }
                    });
            }
        }
    });
};

/**
 * Should be called to create new ContractFactory instance
 *
 * @method ContractFactory
 * @param irc
 * @param {Array} abi
 */
var ContractFactory = function(irc, abi) {
    this.irc = irc;
    this.abi = abi;

    /**
     * Should be called to create new contract on a blockchain
     *
     * @method new
     * @returns {Contract} returns contract instance
     */
    this.new = function() {
        var contract = new Contract(this.irc, this.abi, null);

        // parse arguments
        var options = {}; // required!
        var callback;

        var args = Array.prototype.slice.call(arguments);
        if (utils.isFunction(args[args.length - 1])) {
            callback = args.pop();
        }

        var last = args[args.length - 1];
        if (utils.isObject(last) && !utils.isArray(last)) {
            options = args.pop();
        }

        if (options.value > 0) {
            var constructorAbi = abi.filter(function(json) {
                return json.type === 'constructor' && json.inputs.length === args.length;
            })[0] || {};

            if (!constructorAbi.payable) {
                throw new Error('Cannot send value to non-payable constructor');
            }
        }

        options.data += encodeConstructorParams(this.abi, args);

        if (callback) {

            // wait for the contract address and check if the code was deployed
            this.irc.sendTransaction(options, function(err, hash) {
                if (err) {
                    callback(err);
                } else {
                    // add the transaction hash
                    contract.transactionHash = hash;

                    // call callback for the first time
                    callback(null, contract);

                    checkForContractAddress(contract, callback);
                }
            });
        } else {
            // add the transaction hash
            contract.transactionHash = this.irc.sendTransaction(options);
            checkForContractAddress(contract, null);
        }

        return contract;
    };

    this.new.getData = this.getData.bind(this);
};

/**
 * Should be called to get access to existing contract on a blockchain
 *
 * @method at
 * @param address
 * @param {Function} callback {optional)
 * @returns {Contract} returns contract if no callback was passed,
 * otherwise calls callback function (err, contract)
 */
ContractFactory.prototype.at = function(address, callback) {
    var contract = new Contract(this.irc, this.abi, address);

    // this functions are not part of prototype,
    // because we dont want to spoil the interface
    addFunctionsToContract(contract);
    addEventsToContract(contract);

    if (callback) {
        callback(null, contract);
    }
    return contract;
};

/**
 * Gets the data, which is data to deploy plus constructor params
 *
 * @method getData
 */
ContractFactory.prototype.getData = function() {
    var options = {}; // required!
    var args = Array.prototype.slice.call(arguments);

    var last = args[args.length - 1];
    if (utils.isObject(last) && !utils.isArray(last)) {
        options = args.pop();
    }

    options.data += encodeConstructorParams(this.abi, args);

    return options.data;
};

/**
 * Should be called to create new contract instance
 *
 * @method Contract
 * @param irc
 * @param {Array} abi
 * @param address
 */
var Contract = function(irc, abi, address) {
    this._irc = irc;
    this.transactionHash = null;
    this.address = address;
    this.abi = abi;
};

module.exports = ContractFactory;
