/**
 * @author:    Denis Marchin <denis.marchin@indexexchange.com>
 * @license:   UNLICENSED
 *
 * @copyright: Copyright (c) 2017 by Index Exchange. All rights reserved.
 *
 * The information contained within this document is confidential, copyrighted
 * and or a trade secret. No part of this document may be reproduced or
 * distributed in any form or by any means, in whole or in part, without the
 * prior written permission of Index Exchange.
 */

'use strict';

////////////////////////////////////////////////////////////////////////////////
// Dependencies ////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

var BidTransformer = require('bid-transformer.js');
var Browser = require('browser.js');
var Classify = require('classify.js');
var Network = require('network.js');
var Prms = require('prms.js');
var Constants = require('constants.js');
var Partner = require('partner.js');
var Size = require('size.js');
var SpaceCamp = require('space-camp.js');
var System = require('system.js');
var Utilities = require('utilities.js');
var Whoopsie = require('whoopsie.js');
var EventsService;
var RenderService;

//? if (DEBUG) {
var ConfigValidators = require('config-validators.js');
var PartnerSpecificValidator = require('sonobi-htb-validator.js');
//? }

////////////////////////////////////////////////////////////////////////////////
// Main ////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

/**
 * Sonobi Header Tag Bidder Module
 *
 * @class
 */
function SonobiHtb(configs) {
    /* =====================================
     * Data
     * ---------------------------------- */

    /* Private
     * ---------------------------------- */

    /**
     * Reference to the partner base class.
     *
     * @private {object}
     */
    var __baseClass;

    /**
     * Profile for this partner.
     *
     * @private {object}
     */
    var __profile;

    /**
     * Base url for bid requests.
     *
     * @private {object}
     */
    var __baseUrl;

    /**
     * Instances of BidTransformer for transforming bids.
     *
     * @private {object}
     */
    var __bidTransformers;

    /**
     * Ad response storage for different requests;
     *
     * @private {object}
     */
    var __adResponseStore;

    /* Public
     * ---------------------------------- */

     /**
     * Storage for dynamically generated ad respsonse callbacks.
     * 
     * @private {object}
     */
    var adResponseCallbacks;

    /* =====================================
     * Functions
     * ---------------------------------- */

    /* Utilities
     * ---------------------------------- */

    /**
     * Generates the request URL and query data to the endpoint for the xSlots
     * in the given returnParcels.
     *
     * @param  {object[]} returnParcels
     *
     * @return {object}
     */
    function __generateRequestObj(returnParcels) {

        var keyMaker = {};

        /* Sonobi is SRA so iterate through all returnParcels for xSlotName and sonobiKey */
        for (var i = 0; i < returnParcels.length; i++) {
            var slotName = returnParcels[i].xSlotName;
            var placementID = returnParcels[i].xSlotRef.sonobiKey;
            keyMaker[slotName] = placementID;
        }
        /* Build query string params */
        var queryParams = '?key_maker=' + encodeURIComponent(JSON.stringify(keyMaker));

        /* Make the request inside an iframe and store the iframe for later access */
        var IFrame = Browser.createHiddenIFrame();
        var requestId = '_' + System.generateUniqueId();

        IFrame.contentWindow.sbi = function (responseText) {
            window.parent[SpaceCamp.NAMESPACE][__profile.namespace].adResponseCallbacks[requestId](responseText);
        };

        /* build url */
        var url = __baseUrl + queryParams + '&cv=sbi';

        return {
            url: url,
            callbackId: requestId,
            iframe: IFrame
        };
    }

    /* ------------------------------------------------------------------------------ */

    /* Helpers
     * ---------------------------------- */


    /* Parses and extracts demand from adResponse according to the adapter and then attaches it
     * to the corresponding bid's returnParcel in the correct format using targeting keys.
     */
    function __parseResponse(sessionId, adResponse, returnParcels, outstandingXSlotNames) {
        var bids = adResponse.slots;

        for (var i = 0; i < returnParcels.length; i++) {
            var curReturnParcel = returnParcels[i];

            var xSlotName = curReturnParcel.xSlotName;

            /* Make sure returnParcel has matching bid */
            if (!bids.hasOwnProperty(xSlotName)) {
                continue;
            }

            var bid = bids[xSlotName];

            if (!Utilities.isEmpty(bid)){
                /* Send analytics if enabled by partner */
                if (__profile.enabledAnalytics.requestTime) {
                    EventsService.emit('hs_bidder_bid', {
                        sessionId: sessionId,
                        partnerId: __profile.partnerId,
                        htSlotName: curReturnParcel.htSlot.getName(),
                        xSlotNames: [curReturnParcel.xSlotName]
                    });

                    Utilities.arrayDelete(outstandingXSlotNames[curReturnParcel.htSlot.getName()], curReturnParcel.xSlotName);
                }

                /* Extract size */
                var sizeArray = [Number(bid.sbi_size[0]), Number(bid.sbi_size[1])]; // jshint ignore: line
                curReturnParcel.size = sizeArray; 

                /* Attach targeting keys to returnParcel slots */
                curReturnParcel.targetingType = 'slot';
                curReturnParcel.targeting = {};

                var bidPriceLevel = bid.sbi_mouse; // jshint ignore: line

                /* custom mode sets all the targeting keys that are returned by sonobi */
                if (__baseClass._configs.lineItemType === Constants.LineItemTypes.CUSTOM){
                    for (var targetingKey in bid){
                        if (!bid.hasOwnProperty(targetingKey)){
                            continue;
                        }
                        curReturnParcel.targeting[targetingKey] = bid[targetingKey];
                    }
                } else {
                    var targetingCpm;
                    if (Utilities.isNumeric(bidPriceLevel)) {
                        targetingCpm = __bidTransformers.targeting.apply(bidPriceLevel);
                    } else {
                        targetingCpm = bidPriceLevel;
                    }

                    curReturnParcel.targeting[__baseClass._configs.targetingKeys.om] = [Size.arrayToString(sizeArray) + '_' + targetingCpm];
                    curReturnParcel.targeting.sbi_aid = [bid.sbi_aid]; // jshint ignore: line
                }

                /* server to use for creative, technically page level but assign to every slot because it is used with slot demand */
                if (adResponse.hasOwnProperty('sbi_dc')){
                    returnParcels[i].targeting.sbi_dc = adResponse.sbi_dc; // jshint ignore: line
                }

                //? if(FEATURES.RETURN_CREATIVE) {
                curReturnParcel.adm = '<script type="text/javascript"src="//'+ adResponse.sbi_dc +'apex.go.sonobi.com/sbi.js?as=dfp&aid='+ bid.sbi_aid +'"></script>'; // jshint ignore: line
                //? }

                //? if(FEATURES.RETURN_PRICE) {
                if (Utilities.isNumeric(bidPriceLevel)) {
                    curReturnParcel.price = Number(__bidTransformers.price.apply(bidPriceLevel));
                }
                //? }

            } else {
                if (__profile.enabledAnalytics.requestTime) {
                    EventsService.emit('hs_bidder_pass', {
                        sessionId: sessionId,
                        partnerId: __profile.partnerId,
                        htSlotName: curReturnParcel.htSlot.getName(),
                        xSlotNames: [curReturnParcel.xSlotName]
                    });
                }

                Utilities.arrayDelete(outstandingXSlotNames[curReturnParcel.htSlot.getName()], curReturnParcel.xSlotName);
                curReturnParcel.pass = true;

                continue;
            }            
        }

        if (__profile.enabledAnalytics.requestTime) {
            for (var htSlotName in outstandingXSlotNames) {
                if (!outstandingXSlotNames.hasOwnProperty(htSlotName)) {
                    continue;
                }

                EventsService.emit('hs_bidder_pass', {
                    sessionId: sessionId,
                    partnerId: __profile.partnerId,
                    htSlotName: htSlotName,
                    xSlotNames: outstandingXSlotNames[htSlotName]
                });
            }
        }
    }

    /**
     * Generate an ad response callback that stores ad responses under 
     * callbackId and then deletes itself.
     * 
     * @param {any} callbackId 
     * @returns {fun}
     */
    function __generateAdResponseCallback(callbackId) {
        return function (adResponse) {
            __adResponseStore[callbackId] = adResponse;
            delete adResponseCallbacks[callbackId];
        };
    }

    /**
     * Send a demand request to the partner and store the demand back in the returnParcels.
     * 
     * @param {any} sessionId 
     * @param {any} returnParcels 
     */
    function __sendDemandRequest(sessionId, returnParcels) {
        if (returnParcels.length === 0) {
            return Prms.resolve([]);
        }

        var request = __generateRequestObj(returnParcels);
        var IFrame = request.iframe;
        adResponseCallbacks[request.callbackId] = __generateAdResponseCallback(request.callbackId);

        var xSlotNames = {};

        if (__profile.enabledAnalytics.requestTime) {
            for (var i = 0; i < returnParcels.length; i++) {
                var parcel = returnParcels[i];

                if (!xSlotNames.hasOwnProperty(parcel.htSlot.getName())) {
                    xSlotNames[parcel.htSlot.getName()] = [];
                }

                xSlotNames[parcel.htSlot.getName()].push(parcel.xSlotName);
            }

            for (var htSlotName in xSlotNames) {
                if (!xSlotNames.hasOwnProperty(htSlotName)) {
                    continue;
                }

                EventsService.emit('hs_bidder_request', {
                    sessionId: sessionId,
                    partnerId: __profile.statsId,
                    htSlotName: htSlotName,
                    xSlotNames: xSlotNames[htSlotName]
                });
            }
        }

        return new Prms(function (resolve) {
            EventsService.emit('partner_request_sent', {
                partner: __profile.partnerId,
                //? if (DEBUG) {
                parcels: returnParcels,
                request: request
                //? }
            });

            Network.jsonp({
                url: request.url,
                timeout: __baseClass._configs.timeout,
                sessionId: sessionId,
                globalTimeout: true,
                scope: IFrame.contentWindow,

                //? if (DEBUG) {
                initiatorId: __profile.partnerId,
                //? }

                onSuccess: function (responseText) {
                    var responseObj;

                    if (responseText) {
                        eval.call(null, responseText);
                    }
                    responseObj = __adResponseStore[request.callbackId];
                    delete __adResponseStore[request.callbackId];

                    /* clean up iframe */
                    IFrame.parentNode.removeChild(IFrame);

                    try {
                        __parseResponse(sessionId, responseObj, returnParcels, xSlotNames);
                    } catch (ex) {
                        EventsService.emit('internal_error', __profile.partnerId + ' error parsing demand: ' + ex, ex.stack);
                        EventsService.emit('partner_request_complete', {
                            partner: __profile.partnerId,
                            status: 'error',
                            //? if (DEBUG) {
                            parcels: returnParcels,
                            request: request
                            //? }
                        });
                    }

                    EventsService.emit('partner_request_complete', {
                        partner: __profile.partnerId,
                        status: 'success',
                        //? if (DEBUG) {
                        parcels: returnParcels,
                        request: request
                        //? }
                    });
                    resolve(returnParcels);
                },

                onTimeout: function () {
                    EventsService.emit('partner_request_complete', {
                        partner: __profile.partnerId,
                        status: 'timeout',
                        //? if (DEBUG) {
                        parcels: returnParcels,
                        request: request
                        //? }
                    });

                    /* clean up iframe */
                    IFrame.parentNode.removeChild(IFrame);

                    if (__profile.enabledAnalytics.requestTime) {
                        for (var htSlotName in xSlotNames) {
                            if (!xSlotNames.hasOwnProperty(htSlotName)) {
                                continue;
                            }

                            EventsService.emit('hs_bidder_timeout', {
                                sessionId: sessionId,
                                partnerId: __profile.statsId,
                                htSlotName: htSlotName,
                                xSlotNames: xSlotNames[htSlotName]
                            });
                        }
                    }

                    resolve(returnParcels);
                },

                onFailure: function () {
                    EventsService.emit('partner_request_complete', {
                        partner: __profile.partnerId,
                        status: 'error',
                        //? if (DEBUG) {
                        parcels: returnParcels,
                        request: request
                        //? }
                    });

                    /* clean up iframe */
                    IFrame.parentNode.removeChild(IFrame);

                    if (__profile.enabledAnalytics.requestTime) {
                        for (var htSlotName in xSlotNames) {
                            if (!xSlotNames.hasOwnProperty(htSlotName)) {
                                continue;
                            }

                            EventsService.emit('hs_bidder_error', {
                                sessionId: sessionId,
                                partnerId: __profile.statsId,
                                htSlotName: htSlotName,
                                xSlotNames: xSlotNames[htSlotName]
                            });
                        }
                    }

                    resolve(returnParcels);
                }
            });
        });
    }

    /* send requests for all slots in inParcels */
    function __retriever(sessionId, inParcels) {
        var returnParcelSets = __baseClass._generateReturnParcels(inParcels);
        var demandRequestPromises = [];

        for (var i = 0; i < returnParcelSets.length; i++) {
            demandRequestPromises.push(__sendDemandRequest(sessionId, returnParcelSets[i]));
        }

        return demandRequestPromises;
    }

    /* =====================================
     * Constructors
     * ---------------------------------- */

    (function __constructor() {
        EventsService = SpaceCamp.services.EventsService;
        RenderService = SpaceCamp.services.RenderService;

        __profile = {
            partnerId: 'SonobiHtb',
            namespace: 'SonobiHtb',
            statsId: 'SBI',
            version: '2.0.0',
            targetingType: 'slot',
            enabledAnalytics: {
                requestTime: true
            },
            features: {
                demandExpiry: {
                    enabled: false,
                    value: 0
                },
                rateLimiting: {
                    enabled: false,
                    value: 0
                }
            },
            targetingKeys: {
                id: 'ix_sbi_id',
                om: 'ix_sbi_om'
            },
            lineItemType: Constants.LineItemTypes.ID_AND_SIZE,
            callbackType: Partner.CallbackTypes.CALLBACK_NAME,
            architecture: Partner.Architectures.SRA,
            requestType: Partner.RequestTypes.JSONP
        };

        //? if (DEBUG) {
        var results = ConfigValidators.partnerBaseConfig(configs) || PartnerSpecificValidator(configs);

        if (results) {
            throw Whoopsie('INVALID_CONFIG', results);
        }
        //? }

        // TODO: figure out what to do here
        var bidTransformerConfigs = {
            //? if (FEATURES.GPT_LINE_ITEMS) {
            targeting: {
                inputCentsMultiplier: 1, // Input is in cents
                outputCentsDivisor: 1, // Output as cents
                outputPrecision: 0, // With 0 decimal places
                roundingType: 'FLOOR', // jshint ignore:line
                floor: 0,
                buckets: [{
                    max: 2000, // Up to 20 dollar (above 5 cents)
                    step: 5 // use 5 cent increments
                }, {
                    max: 5000, // Up to 50 dollars (above 20 dollars)
                    step: 100 // use 1 dollar increments
                }]
            },
            //? }
            //? if (FEATURES.RETURN_PRICE) {
            price: {
                inputCentsMultiplier: 1, // Input is in cents
                outputCentsDivisor: 1, // Output as cents
                outputPrecision: 0, // With 0 decimal places
                roundingType: 'NONE',
            },
            //? }
        };

        /* -------------------------------------------------------------------------- */

        if (configs.bidTransformer) {
            //? if (FEATURES.GPT_LINE_ITEMS) {
            bidTransformerConfigs.targeting = configs.bidTransformer;
            //? }
            //? if (FEATURES.RETURN_PRICE) {
            bidTransformerConfigs.price.inputCentsMultiplier = configs.bidTransformer.inputCentsMultiplier;
            //? }
        }

        __bidTransformers = {};

        //? if(['Universal', 'Cassandra', 'PreGpt'].indexOf(PRODUCT) !== -1) {
        __bidTransformers.targeting = BidTransformer(bidTransformerConfigs.targeting);
        //? }
        //? if(['Universal', 'Cassandra', 'PostGpt'].indexOf(PRODUCT) !== -1) {
        __bidTransformers.price = BidTransformer(bidTransformerConfigs.price);
        //? }

        __baseUrl = Browser.getProtocol() + '//apex.go.sonobi.com/trinity.js';

        __baseClass = Partner(__profile, configs, null, {
            retriever: __retriever
        });

        /* adstorage vars */
        adResponseCallbacks = {};
        __adResponseStore = {};

        __baseClass._setDirectInterface({
            adResponseCallbacks: adResponseCallbacks
        });
    })();

    /* =====================================
     * Public Interface
     * ---------------------------------- */

    var derivedClass = {
        /* Class Information
         * ---------------------------------- */

        //? if (DEBUG) {
        __type__: 'SonobiHtb',
        //? }

        //? if (TEST) {
        __baseClass: __baseClass,
        //? }

        /* Data
         * ---------------------------------- */

        //? if (TEST) {
        __profile: __profile,
        __baseUrl: __baseUrl,
        //? }

        /* Functions
         * ---------------------------------- */

        //? if (TEST) {
        __parseResponse: __parseResponse
        //? }
    };

    return Classify.derive(__baseClass, derivedClass);
}

////////////////////////////////////////////////////////////////////////////////
// Exports /////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

module.exports = SonobiHtb;
