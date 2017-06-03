/**
 * @author Pedro Sanders
 * @since v1
 */
import AccountManagerService from 'core/account_manager_service'
import Context from 'core/context'
import AuthHelper from 'utils/auth_helper'
import AclUtil from 'core/acl/acl_util'
import getConfig from 'core/config_util'
import { Status } from 'location/status'

const config = getConfig()
const HashMap = Packages.java.util.HashMap
const SipListener = Packages.javax.sip.SipListener
const Request = Packages.javax.sip.message.Request
const Response = Packages.javax.sip.message.Response
const RouteHeader = Packages.javax.sip.header.RouteHeader
const ToHeader = Packages.javax.sip.header.ToHeader
const FromHeader = Packages.javax.sip.header.FromHeader
const ContactHeader = Packages.javax.sip.header.ContactHeader
const ExpiresHeader = Packages.javax.sip.header.ExpiresHeader
const ViaHeader = Packages.javax.sip.header.ViaHeader
const CSeqHeader = Packages.javax.sip.header.CSeqHeader
const AuthorizationHeader = Packages.javax.sip.header.AuthorizationHeader
const MaxForwardsHeader = Packages.javax.sip.header.MaxForwardsHeader
const ProxyAuthorizationHeader = Packages.javax.sip.header.ProxyAuthorizationHeader
const LogManager = Packages.org.apache.logging.log4j.LogManager
const SipFactory = Packages.javax.sip.SipFactory
const LOG = LogManager.getLogger()
const sipFactory = SipFactory.getInstance()
const messageFactory = sipFactory.createMessageFactory()
const headerFactory = sipFactory.createHeaderFactory()
const addressFactory = sipFactory.createAddressFactory()
const dsam = new Packages.gov.nist.javax.sip.clientauthutils.DigestServerAuthenticationHelper()

export default function (sipProvider, contactHeader, locationService,
    registrarService, dataAPIs, contextStorage) {
    const accountManagerService = new AccountManagerService(dataAPIs)
    const authHelper =  new AuthHelper(headerFactory)
    const dAPI = dataAPIs.DomainsAPI
    const pAPI = dataAPIs.PeersAPI
    const aAPI = dataAPIs.AgentsAPI

    const generalAcl = config.general.accessControlList

    function register(request, transaction) {
        const contactHeader = request.getHeader(ContactHeader.NAME)
        const contactURI = contactHeader.getAddress().getURI()
        const expH = request.getHeader(ExpiresHeader.NAME).getExpires() || contactHeader.getExpires()
        const authHeader = request.getHeader(AuthorizationHeader.NAME)
        const toHeader = request.getHeader(ToHeader.NAME)
        const addressOfRecord = toHeader.getAddress().getURI()

        // See: Removing bindings -> https://tools.ietf.org/html/rfc3261#section-10.2.2
        if (contactHeader.getAddress().isWildcard() && expH <= 0) {
            locationService.removeEndpoint(addressOfRecord)
            const ok = messageFactory.createResponse(Response.OK, request)
            ok.addHeader(contactHeader)
            ok.addHeader(expH)
            transaction.sendResponse(ok)
            LOG.debug('------->\n' + ok)
            return
        } else if (!contactHeader.getAddress().isWildcard() && expH <= 0) {
            locationService.removeEndpoint(addressOfRecord, contactURI)
            const ok = messageFactory.createResponse(Response.OK, request)
            ok.addHeader(contactHeader)
            ok.addHeader(expH)
            transaction.sendResponse(ok)
            LOG.debug('------->\n' + ok)
            return
        }

        if (authHeader == null) {
            const unauthorized = messageFactory.createResponse(Response.UNAUTHORIZED, request)
            unauthorized.addHeader(authHelper.generateChallenge())
            transaction.sendResponse(unauthorized)

            LOG.debug('------->\n' + unauthorized)
        } else {
            if (registrarService.register(request)) {
                const ok = messageFactory.createResponse(Response.OK, request)
                ok.addHeader(contactHeader)
                ok.addHeader(expH)
                transaction.sendResponse(ok)
                LOG.debug('------->\n' + ok)
            } else {
                const unauthorized = messageFactory.createResponse(Response.UNAUTHORIZED, request)
                unauthorized.addHeader(authHelper.generateChallenge(headerFactory))
                transaction.sendResponse(unauthorized)
                LOG.debug('------->\n' + unauthorized)
            }
        }
    }

    function cancel(request, serverTransaction) {
        const storage = contextStorage.getStorage()
        const iterator = storage.iterator()

        while (iterator.hasNext()) {
            const context = iterator.next()
            if (context.serverTransaction && context.serverTransaction.getBranchId()
                .equals(serverTransaction.getBranchId())) {

                let originRequest = context.requestIn
                let originResponse = messageFactory.createResponse(Response.REQUEST_TERMINATED, originRequest)
                let cancelResponse = messageFactory.createResponse(Response.OK, request)
                let cancelRequest = context.clientTransaction.createCancel()
                let clientTransaction = sipProvider.getNewClientTransaction(cancelRequest)

                context.serverTransaction.sendResponse(originResponse)
                serverTransaction.sendResponse(cancelResponse)
                clientTransaction.sendRequest()

                LOG.trace('Original response: ' + originResponse)
                LOG.trace('Cancel response: ' + cancelResponse)
                LOG.trace('Cancel request: ' + cancelRequest)
            }
        }
        LOG.debug('<-------\n' + request)
    }

    this.listener = new SipListener({
        processRequest: function(event) {
            const requestIn = event.getRequest()
            const method = requestIn.getMethod()
            let serverTransaction = event.getServerTransaction()

            // ACK does not need a transaction
            if (serverTransaction == null && !method.equals(Request.ACK)) {
                serverTransaction = sipProvider.getNewServerTransaction(requestIn)
            }

            const requestOut = requestIn.clone()

            if (method.equals(Request.REGISTER)) {
                register(requestIn, serverTransaction)
                return
            } else if(method.equals(Request.CANCEL)) {
                cancel(requestIn, serverTransaction)
                return
            } else {
                const routeHeader = requestIn.getHeader(RouteHeader.NAME)
                const rVia = requestIn.getHeader(ViaHeader.NAME)
                const transport = rVia.getTransport().toLowerCase()
                const contactHeader = requestIn.getHeader(ContactHeader.NAME)
                const contactURI = contactHeader.getAddress().getURI()
                const lp = sipProvider.getListeningPoint(transport)
                const host = lp.getIPAddress().toString()
                const port = lp.getPort()
                const fromHeader = requestIn.getHeader(FromHeader.NAME)
                const fromURI = fromHeader.getAddress().getURI()
                const toHeader = requestIn.getHeader(ToHeader.NAME)

                let addressOfRecord

                // Authenticating
                let result = pAPI.getPeer(fromURI.getUser())
                let user

                if (result.status == Status.OK) {
                    user = result.obj
                } else {
                    result = aAPI.getAgent(fromURI.getHost(), fromURI.getUser())

                    if (result.status == Status.OK ) {
                        user = result.obj
                    }
                }

                if (!dsam.doAuthenticatePlainTextPassword(requestIn, user.spec.credentials.secret)) {
                    const challengeResponse = messageFactory.createResponse(Response.PROXY_AUTHENTICATION_REQUIRED, requestIn)
                    dsam.generateChallenge(headerFactory, challengeResponse, "sip.io")
                    serverTransaction.sendResponse(challengeResponse)
                    LOG.debug('<-------\n' + requestIn)
                    return;
                }

                // Discover DIDs sent via a non-standard header
                // The header must be added at config.general.addressInfo[*]
                // If the such header is present then overwrite the AOR
                if(!!config.general.addressInfo) {
                    config.general.addressInfo.forEach(function(info) {
                        if (!!requestIn.getHeader(info)) addressOfRecord = addressFactory.createTelURL(requestIn.getHeader(info).getValue())
                    })
                } else {
                    addressOfRecord = toHeader.getAddress().getURI()
                }

                // Security check
                result = dAPI.getDomain(addressOfRecord.getHost())

                // TODO: This should not work :(
                if (result.status == Status.OK) {
                    const domainObj = result.obj
                    if(!new AclUtil(generalAcl).isIpAllowed(domainObj, addressOfRecord.getHost())) {
                        serverTransaction.sendResponse(messageFactory.createResponse(Response.UNAUTHORIZED, requestIn))
                        LOG.debug('<-------\n' + requestIn)
                        return
                    }
                }

                if (routeHeader) {
                    const nextHop = routeHeader.getAddress().getURI().getHost()
                    if (nextHop.equals(host) || nextHop.equals(config.general.externalHost)) {
                        requestOut.removeFirst(RouteHeader.NAME)
                    }
                }

                const maxForwardsHeader = requestOut.getHeader(MaxForwardsHeader.NAME)
                maxForwardsHeader.decrementMaxForwards()

                // Stay in the signaling path?
                if (config.general.recordRoute) {
                    const proxyUri = addressFactory.createSipURI(null, host)
                    proxyUri.setLrParam()
                    const proxyAddress = addressFactory.createAddress(proxyUri)
                    const recordRouteHeader = headerFactory.createRecordRouteHeader(proxyAddress)
                    requestOut.addHeader(recordRouteHeader)
                }

                // Request RPort for Symmetric Response Routing in accordance with RFC 3581
                const viaHeader = headerFactory.createViaHeader(host, port, transport, null)
                viaHeader.setRPort()
                requestOut.addFirst(viaHeader)

                function processRoute(route) {
                    requestOut.setRequestURI(route.contactURI)

                    if (route.thruGw) {
                        const fromHeader = requestIn.getHeader(FromHeader.NAME)
                        const toHeader = requestIn.getHeader(ToHeader.NAME)
                        const gwRef = headerFactory.createHeader('GwRef', route.gwRef)
                        const from = 'sip:' + route.gwUsername + '@' + route.gwHost
                        const to = 'sip:' + toHeader.getAddress().toString().match('sips?:(.*)@(.*)')[1] + '@' + route.gwHost

                        // This might not work with all provider
                        const fromAddress = addressFactory.createAddress(from)
                        fromAddress.setDisplayName(route.did)
                        const toAddress = addressFactory.createAddress(to)

                        fromHeader.setAddress(fromAddress)
                        toHeader.setAddress(toAddress)

                        requestOut.setHeader(gwRef)
                        requestOut.setHeader(fromHeader)
                        requestOut.setHeader(toHeader)
                   }

                    // Does not need a transaction
                    if(method.equals(Request.ACK)) {
                        sipProvider.sendRequest(requestOut)
                    } else {
                        try {
                            const clientTransaction = sipProvider.getNewClientTransaction(requestOut)
                            clientTransaction.sendRequest()

                            // Transaction context
                            const context = new Context()
                            context.clientTransaction = clientTransaction
                            context.serverTransaction = serverTransaction
                            context.method = method
                            context.requestIn = requestIn
                            context.requestOut = requestOut
                            contextStorage.saveContext(context)
                        } catch (e) {
                            if (e instanceof java.net.ConnectException) {
                                LOG.error('Connection refused. Please see: https://docs.oracle.com/javase/7/docs/api/java/net/ConnectException.html')
                            } else if (e instanceof java.net.NoRouteToHostException) {
                                LOG.error('No route to host. Please see: https://docs.oracle.com/javase/7/docs/api/java/net/NoRouteToHostException.html')
                            } else {
                                LOG.error(e.getStackTrace())
                            }
                        }
                    }

                    LOG.debug('<-------\n' + requestOut)
                }

                // Peer Egress Routing
               /* if (isFromPeerThruGw(requestIn)) {
                    // Extract didRef
                    const didRef = requestIn.getHeader('DIDRef').value
                    const result = locationService.getEgressRouteForPeer(addressOfRecord, didRef)

                    if (result.status == Status.NOT_FOUND) {
                        serverTransaction.sendResponse(messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                        LOG.debug('<-------\n' + requestIn)
                        return
                    }

                    const route = result.obj
                    processRoute(route)

                    LOG.debug('<-------\n' + requestOut)
                    return
                }*/

                result = locationService.findEndpoint(addressOfRecord)

                if (result.status == Status.NOT_FOUND) {
                    serverTransaction.sendResponse(messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                    LOG.debug('<-------\n' + requestIn)
                    return
                }

                const location = result.obj

                // Forking transmission
                if (location instanceof HashMap) {
                    let caIterator

                    try {
                        caIterator = location.values().iterator()
                    } catch(e) {}

                    if (!caIterator.hasNext()) {
                        serverTransaction.sendResponse(messageFactory.createResponse(Response.TEMPORARILY_UNAVAILABLE, requestIn))
                        LOG.debug('<-------\n' + requestIn)
                        return
                    }

                    // Fork the call if needed
                    while(caIterator.hasNext()) {
                        const route = caIterator.next()
                        processRoute(route)
                    }
                } else {
                    const route = location
                    processRoute(route)
                }

                return
            }
            LOG.debug('<-------\n' + requestIn)
        },

        processResponse: function(event) {
            const responseIn = event.getResponse()
            const cseq = responseIn.getHeader(CSeqHeader.NAME)

            // The stack takes care of this cases
            if (responseIn.getStatusCode() == Response.TRYING ||
                responseIn.getStatusCode() == Response.REQUEST_TERMINATED ||
                cseq.getMethod().equals(Request.CANCEL)) return

            const clientTransaction = event.getClientTransaction()

            // WARNING: This is causing an issue with tcp transport and DIDLogic
            // I believe that DIDLogic does not fully support tcp registration
            if (responseIn.getStatusCode() == Response.PROXY_AUTHENTICATION_REQUIRED ||
                responseIn.getStatusCode() == Response.UNAUTHORIZED) {
                let authenticationHelper = sipProvider.getSipStack()
                    .getAuthenticationHelper(accountManagerService.getAccountManager(), headerFactory)
                let t = authenticationHelper.handleChallenge(responseIn, clientTransaction, event.getSource(), 5)
                t.sendRequest()
                LOG.debug('<-------\n' + responseIn)
                return
            }

            // Strip the topmost via header
            const responseOut = responseIn.clone()
            responseOut.removeFirst(ViaHeader.NAME)

            if (cseq.getMethod().equals(Request.INVITE) && !!clientTransaction) {
                // In theory we should be able to obtain the ServerTransaction casting the ApplicationData.
                // However, I'm unable to find the way to cast this object.
                //let st = clientTransaction.getApplicationData()'

                const context = contextStorage.findContext(clientTransaction)

                if (!!context && !!context.serverTransaction) context.serverTransaction.sendResponse(responseOut)

            } else {
                // Could be a BYE due to Record-Route
                // There is no more Via headers; the response was intended for the proxy.
                if (!!responseOut.getHeader(ViaHeader.NAME)) sipProvider.sendResponse(responseOut)
            }
            LOG.debug('------->\n' + responseOut)
        },

        processTransactionTerminated: function(event) {
            if (event.isServerTransaction()) {
                const serverTransaction = event.getServerTransaction()

                if (!contextStorage.removeContext(serverTransaction)) {
                   LOG.trace("Ongoing Transaction")
                }
            }
        },

        processDialogTerminated: function(event) {
            LOG.trace('Dialog ' + event.getDialog() + ' has been terminated')
        },

        processTimeout: function(event) {
            LOG.trace('Transaction Time out')
        }
    })
}
