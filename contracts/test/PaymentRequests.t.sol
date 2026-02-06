// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PaymentRequests.sol";

contract PaymentRequestsTest is Test {
    PrivatePaymentRequests public requests;
    
    address alice = address(0x1);
    address bob = address(0x2);
    
    function setUp() public {
        requests = new PrivatePaymentRequests();
    }
    
    function testCreateRequest() public {
        bytes8 tag = bytes8(keccak256("bob_pubkey"));
        bytes memory encrypted = hex"deadbeef";
        
        vm.prank(alice);
        uint256 requestId = requests.createRequest(tag, encrypted);
        
        assertEq(requestId, 0);
        
        PrivatePaymentRequests.EncryptedRequest memory request = requests.getRequest(0);
        assertEq(request.recipientTag, tag);
        assertEq(request.encryptedPayload, encrypted);
        assertEq(uint(request.status), uint(PrivatePaymentRequests.RequestStatus.Pending));
    }
    
    function testApproveRequest() public {
        bytes8 tag = bytes8(keccak256("bob_pubkey"));
        bytes memory encrypted = hex"deadbeef";
        
        vm.prank(alice);
        uint256 requestId = requests.createRequest(tag, encrypted);
        
        vm.prank(bob);
        requests.approveRequest(requestId, bytes32("tx_hash"));
        
        PrivatePaymentRequests.EncryptedRequest memory request = requests.getRequest(requestId);
        assertEq(uint(request.status), uint(PrivatePaymentRequests.RequestStatus.Approved));
    }
    
    function testRejectRequest() public {
        bytes8 tag = bytes8(keccak256("bob_pubkey"));
        bytes memory encrypted = hex"deadbeef";
        
        vm.prank(alice);
        uint256 requestId = requests.createRequest(tag, encrypted);
        
        vm.prank(bob);
        requests.rejectRequest(requestId);
        
        PrivatePaymentRequests.EncryptedRequest memory request = requests.getRequest(requestId);
        assertEq(uint(request.status), uint(PrivatePaymentRequests.RequestStatus.Rejected));
    }
    
    function testGetRequestsByTag() public {
        bytes8 tag = bytes8(keccak256("bob_pubkey"));
        
        vm.prank(alice);
        requests.createRequest(tag, hex"aabbccdd");
        
        vm.prank(alice);
        requests.createRequest(tag, hex"eeff0011");
        
        uint256[] memory bobRequests = requests.getRequestsByTag(tag);
        assertEq(bobRequests.length, 2);
        assertEq(bobRequests[0], 0);
        assertEq(bobRequests[1], 1);
    }
}
