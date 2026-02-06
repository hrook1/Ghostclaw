// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

/// @title MockPermit2
/// @notice A mock Permit2 contract for testing - accepts any signature
contract MockPermit2 is ISignatureTransfer {
    /// @notice Transfers tokens from owner to recipient, ignoring signature (for testing)
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata /* signature */
    ) external {
        // Simply do a transferFrom - in tests, owner must have approved this contract
        IERC20(permit.permitted.token).transferFrom(
            owner,
            transferDetails.to,
            transferDetails.requestedAmount
        );
    }

    /// @notice Batch transfer - not implemented for testing
    function permitTransferFrom(
        PermitBatchTransferFrom calldata /* permit */,
        SignatureTransferDetails[] calldata /* transferDetails */,
        address /* owner */,
        bytes calldata /* signature */
    ) external pure {
        revert("Not implemented");
    }

    /// @notice Witness transfer - not implemented for testing
    function permitWitnessTransferFrom(
        PermitTransferFrom calldata /* permit */,
        SignatureTransferDetails calldata /* transferDetails */,
        address /* owner */,
        bytes32 /* witness */,
        string calldata /* witnessTypeString */,
        bytes calldata /* signature */
    ) external pure {
        revert("Not implemented");
    }

    /// @notice Batch witness transfer - not implemented for testing
    function permitWitnessTransferFrom(
        PermitBatchTransferFrom calldata /* permit */,
        SignatureTransferDetails[] calldata /* transferDetails */,
        address /* owner */,
        bytes32 /* witness */,
        string calldata /* witnessTypeString */,
        bytes calldata /* signature */
    ) external pure {
        revert("Not implemented");
    }

    /// @notice Invalidate nonces - not implemented for testing
    function invalidateNonces(
        uint256 /* wordPos */,
        uint256 /* mask */
    ) external pure {
        revert("Not implemented");
    }

    /// @notice Invalidate unordered nonces - not implemented for testing
    function invalidateUnorderedNonces(
        uint256 /* wordPos */,
        uint256 /* mask */
    ) external pure {
        revert("Not implemented");
    }

    /// @notice Nonce bitmap - returns 0 for testing
    function nonceBitmap(
        address /* owner */,
        uint256 /* wordPos */
    ) external pure returns (uint256) {
        return 0;
    }

    /// @notice Domain separator - returns a dummy value for testing
    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return keccak256("MockPermit2");
    }
}
