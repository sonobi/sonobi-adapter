/**
 * @author:    Partner
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
var Constants = require('constants.js');
var Partner = require('partner.js');
var SpaceCamp = require('space-camp.js');
var System = require('system.js');
var Utilities = require('utilities.js');
var Whoopsie = require('whoopsie.js');
var EventsService;
var RenderService;

//? if (DEBUG) {
var ConfigValidators = require('config-validators.js');
var PartnerSpecificValidator = require('sonobi-htb-validator.js');
var Inspector = require('schema-inspector.js');
//? }

////////////////////////////////////////////////////////////////////////////////
// Main ////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

/**
 * Partner module template
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
        //? if (DEBUG){
        var results = Inspector.validate({
            type: 'array',
            exactLength: 1,
            items: {
                type: 'object',
                properties: {
                    htSlot: {
                        type: 'object'
                    },
                    xSlotRef: {
                        type: 'object'
                    },
                    xSlotName: {
                        type: 'string',
                        minLength: 1
                    }
                }
            }
        }, returnParcels);
        if (!results.valid) {
            throw Whoopsie('INVALID_ARGUMENT', results.format());
        }
        //? }

        // building Sonobi's keyMaker URL params for the queryObj
        var keyMaker = {};
        // Sonobi is SRA so include all returnParcels
        for (var i = 0; i < returnParcels.length; i++) {
            var slotName = returnParcels[i].xSlotName;
            var placementID = returnParcels[i].xSlotRef.sonobiKey;
            keyMaker[slotName] = placementID;
        }
        var queryObj = encodeURIComponent(JSON.stringify(keyMaker));

        /* generate a unique request identifier for storing request-specific information */
        var requestId = '_' + System.generateUniqueId();

        /* callback function using the unique request ID */
        var callback = 'window.' + SpaceCamp.NAMESPACE + '.' + __profile.namespace + '.adResponseCallbacks.' + requestId;

        return {
            url: __baseUrl,
            data: queryObj,
            callbackId: callback
        };
    }

    function adResponseCallback(adResponse) {
        /* get callbackId from adResponse here */
        var callbackId = 0;
        __baseClass._adResponseStore[callbackId] = adResponse;
    }
    /* ------------------------------------------------------------------------------ */

    /* Helpers
     * ---------------------------------- */

    /**
     * This function will render the ad given.
     *
     * @param  {Object} doc The document of the iframe where the ad will go.
     * @param  {string} adm The ad code that came with the original demand.
     */
    function __render(doc, adm) {
        System.documentWrite(doc, adm);
    }

    /* Parses and extracts demand from adResponse according to the adapter and then attaches it
     * to the corresponding bid's returnParcel in the correct format using targeting keys.
     */
    function __parseResponse(sessionId, adResponse, returnParcels, outstandingXSlotNames) {
        var bids = adResponse.slots;

        // Sonobi is SRA so loop through all returnParcels
        for (var i = 0; i < returnParcels.length; i++) {
            var curReturnParcel = returnParcels[i];

            // Make sure returnParcel has matching bid
            if (!bids.hasOwnProperty(curReturnParcel.xSlotName)) {
                continue;
            }

            // Send analytics if enabled by partner
            if (__profile.enabledAnalytics.requestTime) {
                EventsService.emit('bidder_bid', {
                    sessionId: sessionId,
                    partnerId: __profile.partnerId,
                    htSlotName: curReturnParcel.htSlot.getName(),
                    xSlotNames: [curReturnParcel.xSlotName]
                });

                Utilities.arrayDelete(outstandingXSlotNames[curReturnParcel.htSlot.getName()], curReturnParcel.xSlotName);
            }

            // Attach targeting keys to returnParcel slots
            returnParcels[i].targetingType = 'slot';
            returnParcels[i].targeting = bids[curReturnParcel.xSlotName];
        }

        if (__profile.enabledAnalytics.requestTime) {
            for (var htSlotName in outstandingXSlotNames) {
                if (!outstandingXSlotNames.hasOwnProperty(htSlotName)) {
                    continue;
                }

                EventsService.emit('bidder_pass', {
                    sessionId: sessionId,
                    partnerId: __profile.partnerId,
                    htSlotName: htSlotName,
                    xSlotNames: outstandingXSlotNames[htSlotName]
                });
            }
        }

        returnParcels.push({
            partnerId: __profile.partnerId,
            targetingType: 'page',
            targeting: {
                'sbi_dc': adResponse.sbi_dc // jshint ignore:line
            }
        });
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
            // TODO: Figure out what to do for targetingKeys section
            targetingKeys: {
                id: 'ix_sbi_id',
                om: 'ix_sbi_om',
                pm: 'ix_sbi_pm'
                // In Sonobi partner doc these targeting keys are listed
                // sbi_ct:
                // sbi_apoc: premium
                // sbi_aid: 102.131.195_r4on9
                // sbi_size: 300x250
                // sbi_mouse: 4.25
                // "sbi_dc"
            },
            lineItemType: Constants.LineItemTypes.ID_AND_SIZE,
            callbackType: Partner.CallbackTypes.CALLBACK_NAME,
            architecture: Partner.Architectures.SRA
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

        __baseUrl = Browser.getProtocol() + 'apex.go.sonobi.com/trinity.js?key_maker=';

        __baseClass = Partner(__profile, configs, null, {
            parseResponse: __parseResponse,
            generateRequestObj: __generateRequestObj,
            adResponseCallback: adResponseCallback
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
        __render: __render,
        __parseResponse: __parseResponse,

        adResponseCallback: adResponseCallback,
        //? }
    };

    return Classify.derive(__baseClass, derivedClass);
}

////////////////////////////////////////////////////////////////////////////////
// Exports /////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////

module.exports = SonobiHtb;
