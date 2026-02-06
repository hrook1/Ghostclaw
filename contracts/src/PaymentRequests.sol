// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PrivatePaymentRequests
/// @notice Privacy-preserving payment requests using tagged encryption
contract PrivatePaymentRequests {
    
    struct EncryptedRequest {
        bytes8 recipientTag;         // First 8 bytes of keccak256(recipientPubKey)
        bytes encryptedPayload;      // Encrypted request data
        uint256 timestamp;
        RequestStatus status;
    }
    
    enum RequestStatus { 
        Pending,    // 0: Awaiting response
        Approved,   // 1: Paid
        Rejected,   // 2: Declined
        Expired     // 3: Timed out
    }
    
    // Storage
    EncryptedRequest[] public allRequests;
    mapping(bytes8 => uint256[]) public requestsByTag;
    
    // Constants
    uint256 public constant EXPIRATION_TIME = 7 days;
    uint256 public constant REQUEST_FEE = 0; // Can add spam protection fee later
    
    // Events
    event RequestCreated(
        uint256 indexed requestId,
        bytes8 indexed recipientTag,
        bytes encryptedPayload,
        uint256 timestamp
    );
    
    event RequestApproved(
        uint256 indexed requestId,
        bytes32 txHash
    );
    
    event RequestRejected(
        uint256 indexed requestId
    );
    
    event RequestExpired(
        uint256 indexed requestId
    );
    
    // Errors
    error InvalidRequest();
    error RequestNotFound();
    error RequestNotPending();
    error RequestAlreadyExpired();
    error InsufficientFee();
    
    /// @notice Create a new encrypted payment request
    /// @param _recipientTag First 8 bytes of keccak256(recipientPubKey)
    /// @param _encryptedPayload Encrypted request data (requester, amount, message, etc)
    /// @return requestId The ID of the created request
    function createRequest(
        bytes8 _recipientTag,
        bytes calldata _encryptedPayload
    ) external payable returns (uint256) {
        if (_recipientTag == bytes8(0)) revert InvalidRequest();
        if (_encryptedPayload.length == 0) revert InvalidRequest();
        if (msg.value < REQUEST_FEE) revert InsufficientFee();
        
        uint256 requestId = allRequests.length;
        
        allRequests.push(EncryptedRequest({
            recipientTag: _recipientTag,
            encryptedPayload: _encryptedPayload,
            timestamp: block.timestamp,
            status: RequestStatus.Pending
        }));
        
        requestsByTag[_recipientTag].push(requestId);
        
        emit RequestCreated(
            requestId,
            _recipientTag,
            _encryptedPayload,
            block.timestamp
        );
        
        return requestId;
    }
    
    /// @notice Approve a payment request (called after payment is made)
    /// @param _requestId The request ID
    /// @param _txHash Hash of the payment transaction
    function approveRequest(
        uint256 _requestId,
        bytes32 _txHash
    ) external {
        if (_requestId >= allRequests.length) revert RequestNotFound();
        
        EncryptedRequest storage request = allRequests[_requestId];
        
        if (request.status != RequestStatus.Pending) revert RequestNotPending();
        
        // Check if expired
        if (block.timestamp > request.timestamp + EXPIRATION_TIME) {
            request.status = RequestStatus.Expired;
            emit RequestExpired(_requestId);
            revert RequestAlreadyExpired();
        }
        
        request.status = RequestStatus.Approved;
        emit RequestApproved(_requestId, _txHash);
    }
    
    /// @notice Reject a payment request
    /// @param _requestId The request ID
    function rejectRequest(uint256 _requestId) external {
        if (_requestId >= allRequests.length) revert RequestNotFound();
        
        EncryptedRequest storage request = allRequests[_requestId];
        
        if (request.status != RequestStatus.Pending) revert RequestNotPending();
        
        request.status = RequestStatus.Rejected;
        emit RequestRejected(_requestId);
    }
    
    /// @notice Mark an expired request as expired
    /// @param _requestId The request ID
    function markExpired(uint256 _requestId) external {
        if (_requestId >= allRequests.length) revert RequestNotFound();
        
        EncryptedRequest storage request = allRequests[_requestId];
        
        if (request.status != RequestStatus.Pending) revert RequestNotPending();
        if (block.timestamp <= request.timestamp + EXPIRATION_TIME) revert InvalidRequest();
        
        request.status = RequestStatus.Expired;
        emit RequestExpired(_requestId);
    }
    
    /// @notice Get all request IDs for a given tag
    /// @param _tag The recipient tag
    /// @return Array of request IDs
    function getRequestsByTag(bytes8 _tag) external view returns (uint256[] memory) {
        return requestsByTag[_tag];
    }
    
    /// @notice Get request details
    /// @param _requestId The request ID
    /// @return The full request struct
    function getRequest(uint256 _requestId) external view returns (EncryptedRequest memory) {
        if (_requestId >= allRequests.length) revert RequestNotFound();
        return allRequests[_requestId];
    }
    
    /// @notice Get total number of requests
    /// @return Total count
    function getRequestCount() external view returns (uint256) {
        return allRequests.length;
    }
    
    /// @notice Check if a request is expired
    /// @param _requestId The request ID
    /// @return True if expired
    function isExpired(uint256 _requestId) external view returns (bool) {
        if (_requestId >= allRequests.length) return false;
        
        EncryptedRequest memory request = allRequests[_requestId];
        
        if (request.status != RequestStatus.Pending) return false;
        
        return block.timestamp > request.timestamp + EXPIRATION_TIME;
    }
}
