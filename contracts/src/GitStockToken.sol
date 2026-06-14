// SPDX-License-Identifier: Apache-2.0
// https://gitbank.io
pragma solidity 0.8.34;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title GitStockToken
 * @notice Soul-bound ERC-20 representing 1:1 ownership of an Ondo tokenized
 *         stock held in Gitbank Solana custody. One contract per stock ticker,
 *         shared across all Gitbank users.
 *
 *         Only the Gitbank relayer (minter address) can mint or burn.
 *         Transfers and approvals are permanently disabled — the token is a
 *         proof-of-custody receipt, not a tradeable asset.
 *
 *         Decimals: 9 (matches Ondo Token-2022 SPL tokens on Solana).
 */
contract GitStockToken is ERC20 {
    address public immutable minter;   // Gitbank relayerSigner EOA
    address public immutable factory;  // GitStockFactory that deployed this
    string  public ticker;             // e.g. "NVDA", "AAPL"

    modifier onlyMinter() {
        require(msg.sender == minter, "GitStockToken: only minter");
        _;
    }

    constructor(
        string memory name_,    // e.g. "Gitbank NVIDIA"
        string memory symbol_,  // e.g. "gitNVDA"
        string memory ticker_,  // e.g. "NVDA"
        address minter_,
        address factory_
    ) ERC20(name_, symbol_) {
        require(minter_  != address(0), "GitStockToken: zero minter");
        require(factory_ != address(0), "GitStockToken: zero factory");
        minter  = minter_;
        factory = factory_;
        ticker  = ticker_;
    }

    function decimals() public pure override returns (uint8) {
        return 9;
    }

    /**
     * @notice Mint gitStock tokens to a recipient.
     *         Called by the relayer after buying Ondo stock on Solana.
     */
    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /**
     * @notice Burn gitStock tokens from a holder.
     *         Called by the relayer before selling Ondo stock on Solana.
     */
    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }

    // ── Soul-bound: all P2P movement permanently disabled ────────────────────

    function transfer(address, uint256) public pure override returns (bool) {
        revert("gitStock: soul-bound, transfers disabled");
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert("gitStock: soul-bound, transfers disabled");
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert("gitStock: soul-bound, approvals disabled");
    }
}
